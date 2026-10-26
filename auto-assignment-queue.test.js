const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');
function setup(waiting, holds = [], occupied = {}) {
  const beds = { ...occupied };
  const events = [];
  const context = {
    autoBedAssignEnabled: true, isAssigningWaitingPatients: false, shouldAssignWaitingAgain: false,
    bedAssignments: [], doctorBedMap: {}, REGULAR_BED_NUMBERS: [1], REGULAR_BED_COUNT: 1,
    getHoldBedEntries: () => holds.filter(h => !h.moved),
    getWaitingPatients: () => waiting.filter(([key]) => !Object.values(beds).some(b => b.patientKey === key)),
    getBedData: no => beds[no], updateBedRecord: async () => {},
    assignPatientToBed: async (key, data) => {
      const no = data.visitType === '초진' ? ({ a: 101, b: 102 }[data.doctorId]) : 1;
      if (!no || beds[no]) return false;
      beds[no] = { patientKey: key }; events.push(key); return no;
    },
    window: { moveOrSwapBed: async (from, to) => {
      if (beds[to]) return false;
      const held = holds.find(h => h.bedNo === from);
      held.moved = true; beds[to] = held.bed; events.push(held.bed.patientKey); return true;
    }}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function assignWaitingPatientsToBeds('), source.indexOf('  window.assignWaitingPatientsManually')), context);
  return { context, events, beds };
}
const initial = (key, doctorId, timestamp, extra = {}) => [key, { name: key, visitType: '초진', doctorId, timestamp, ...extra }];
const held = (target, queuedAt) => ({ bedNo: 901, bed: { patientKey: 'held', pendingTargetBedNo: target, holdQueuedAt: queuedAt } });
test('occupied doctor room does not block another doctor; same-doctor FIFO remains', async () => {
  const s = setup([initial('a1','a',1), initial('b1','b',2), initial('a2','a',3)], [], {101:{patientKey:'chuna'}});
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['b1']);
  delete s.beds[101]; await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['b1','a1']);
});
test('unselected and unavailable doctors do not block available doctors', async () => {
  const s = setup([initial('none','',1), initial('away','missing',2), initial('b','b',3)]);
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['b']);
});
test('earlier treatment hold wins over initial visit for same room', async () => {
  const s = setup([initial('initial','a',20)], [held(101,10)]);
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['held']);
});
test('earlier initial visit wins over treatment hold for same room', async () => {
  const s = setup([initial('initial','a',10)], [held(101,20)]);
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['initial']);
});
test('late doctor selection uses selection time instead of reception time', async () => {
  const s = setup([initial('late','a',1,{initialVisitQueuedAt:30}), initial('earlier','a',20)]);
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['earlier']);
});
test('hold releases without unassigned patients and other destinations remain independent', async () => {
  const s = setup([], [held(101,1), {bedNo:902,bed:{patientKey:'spine',pendingTargetBedNo:15,holdQueuedAt:2}}], {101:{patientKey:'busy'}});
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['spine']);
});
test('full regular beds do not block initial visits', async () => {
  const s = setup([['regular',{name:'regular',timestamp:1}],initial('initial','b',2)],[],{1:{patientKey:'busy'}});
  await s.context.assignWaitingPatientsToBeds(); assert.deepEqual(s.events, ['initial']);
});


test('manual waiting patients are skipped without blocking later automatic patients', async () => {
  const s = setup([
    initial('manual', 'a', 1, { assignmentMode: 'manual' }),
    initial('automatic', 'a', 2)
  ]);
  await s.context.assignWaitingPatientsToBeds();
  assert.deepEqual(s.events, ['automatic']);
});

test('bulk assignment also preserves manual waiting even when automatic assignment is off', async () => {
  const s = setup([initial('manual', 'a', 1, { assignmentMode: 'manual' }), initial('auto', 'b', 2)]);
  s.context.autoBedAssignEnabled = false;
  await s.context.assignWaitingPatientsToBeds(true);
  assert.deepEqual(s.events, ['auto']);
});

test('resuming automatic assignment makes a manual patient eligible again', async () => {
  const patient = initial('manual', 'a', 1, { assignmentMode: 'manual' });
  const s = setup([patient]);
  await s.context.assignWaitingPatientsToBeds();
  assert.deepEqual(s.events, []);
  patient[1].assignmentMode = 'auto';
  await s.context.assignWaitingPatientsToBeds();
  assert.deepEqual(s.events, ['manual']);
});

function setupMoveToWaiting(failSave = false) {
  const events = [];
  const patient = { patientKey: 'p', name: '환자', treatments: ['치료'], running: true };
  const context = {
    window: {}, getBedData: () => patient, clearLocalTimerAlertsForBed: () => {},
    patientsByKey: new Map([['p', { name: '환자' }]]), showToast: () => {}, console,
    updatePatient: async (key, patch) => {
      events.push(['save', patch]);
      if (failSave) throw new Error('save failed');
    },
    removeBedRecord: async no => events.push(['remove', no])
  };
  vm.createContext(context);
  const start = source.indexOf('  window.moveBedToWaiting = async');
  vm.runInContext(source.slice(start, source.indexOf('\n  };', start) + 6), context);
  return { context, events };
}

test('returning to waiting persists manual mode before freeing the bed', async () => {
  const s = setupMoveToWaiting();
  assert.equal(await s.context.window.moveBedToWaiting(1), true);
  assert.deepEqual(s.events.map(([type]) => type), ['save', 'remove']);
  const patch = s.events[0][1];
  assert.equal(patch.assignmentMode, 'manual');
  assert.equal(patch.bedStatus, 'waiting');
  assert.equal(patch.bedNo, null);
  assert.equal(patch.running, undefined);
  assert.equal(s.context.patientsByKey.get('p').assignmentMode, 'manual');
});

test('failed manual waiting save does not free the bed', async () => {
  const s = setupMoveToWaiting(true);
  s.context.console = { error() {} };
  assert.equal(await s.context.window.moveBedToWaiting(1), false);
  assert.deepEqual(s.events.map(([type]) => type), ['save']);
});
