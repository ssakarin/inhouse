const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { reconcileAssignmentAlerts, startInitialExamOnConfirmation } = require('./bed-assignment-alerts');
const signageState = require('./signage-state');
const source = fs.readFileSync(`${__dirname}/server.js`, 'utf8');
const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const a = { patientKey: 'a', name: '테스트A', running: true, currentIndex: 2 };
const b = { patientKey: 'b', name: '테스트B' };

test('initial exam name confirmation starts the exam and still calls signage once', async () => {
  for (const [no, treatment] of [[101, '진찰'], [3, '베드진찰']]) {
    const bed = { patientKey: 'first', name: '초기환자', treatments: [treatment, '침'], currentIndex: 0, stageEnteredAt: 1000 };
    const s = server({ [no]: bed }, { arrival: { bedNo: no, patientKey: 'first' } });
    await s.confirm('arrival');
    assert.ok(s.state.beds[no].doctorProcedureStartedAt > 0);
    assert.equal(s.state.beds[no].doctorProcedureStartedTreatment, treatment);
    assert.equal(s.state.beds[no].running, undefined);
    assert.equal(s.state.beds[no].stageEnteredAt, 1000);
    assert.equal(s.state.signageCalls.length, 1);
    assert.equal(s.state.signageCalls[0].pending, undefined);
    const startedAt = s.state.beds[no].doctorProcedureStartedAt;
    await s.confirm('arrival');
    assert.equal(s.state.beds[no].doctorProcedureStartedAt, startedAt);
    assert.equal(s.state.signageCalls.length, 1);
  }
});

test('arrival auto-start excludes other treatments, later steps, resumed visits and stale confirmations', () => {
  for (const bed of [
    { treatments: ['침'], currentIndex: 0 }, { treatments: ['약침4'], currentIndex: 0 },
    { treatments: ['진찰'], currentIndex: 0, initialExamOnArrival: false },
    { treatments: ['침', '진찰'], currentIndex: 1 }, { treatments: ['진찰'], complete: true }
  ]) assert.equal(startInitialExamOnConfirmation({ 1: { patientKey: 'p', ...bed } }, { bedNo: 1, patientKey: 'p' }), null);
  assert.equal(startInitialExamOnConfirmation({ 1: { patientKey: 'new', treatments: ['진찰'] } }, { bedNo: 1, patientKey: 'old' }), null);
});

function server(beds, alerts) {
  let serial = 0;
  const state = { beds, bedAssignmentAlerts: alerts,
    signageCalls: signageState.onAssignment([], {}, beds, Date.now(), () => String(++serial)) };
  const frames = [];
  const c = vm.createContext({
    reconcileAssignmentAlerts, startInitialExamOnConfirmation, signageState, crypto: {randomUUID: () => String(++serial)},
    cloneJson: x => structuredClone(x), stampBedStageTimes: (_, next) => next,
    getBedsState: () => state.beds, getStateValue: key => state[key],
    setStateValue: (key, value) => {state[key] = value;},
    stateEquals: (x, y) => JSON.stringify(x) === JSON.stringify(y),
    getBedsVersion: () => state.__bedsVersion || 0, diffBeds: () => ({updates: [], removes: []}),
    sseBroadcastBedsDelta: () => frames.push('beds'),
    sseBroadcastState: (key, value) => frames.push({key, value}),
    sseBroadcastStateChild: () => frames.push('confirmation'),
    readJson: async req => req.body, normalizeStateKey: key => key,
    assertValidChartNoRecord: () => {}, jsonResponse: () => {}
  });
  vm.runInContext(source.slice(source.indexOf('function commitBeds('), source.indexOf('async function handleApi(')), c);
  const child = source.slice(source.indexOf('  const childMatch = pathname.match'), source.indexOf('  if (pathname === "/api/discharged-patients/cleanup"'));
  vm.runInContext('async function handle(req,res,pathname){' + child + '}', c);
  return {state, frames, move: beds => c.commitBeds(beds), confirm: key => c.handle(
    {method:'POST',body:{key:'bedAssignmentAlerts',childKey:key,confirmed:true}}, {}, '/api/state-child/delete')};
}

for (const [no, treatments] of [[101, ['침', '단추']], [101, ['침', '약침4']], [15, ['침', '단추', '벤치']]]) {
  test(`waiting-room return confirmation starts ${treatments[1]} in ${no} without a signage announcement`, async () => {
    const bed = { patientKey: 'return', name: '복귀환자', initialExamOnArrival: false,
      treatments, currentIndex: 1, stageEnteredAt: 1000, remaining: 300, total: 300 };
    const alert = { bedNo: no, patientKey: 'return', returnFromWaiting: true, treatmentIndex: 1, treatmentName: treatments[1] };
    const s = server({ [no]: bed }, { arrival: alert });
    await s.confirm('arrival');
    assert.equal(s.state.beds[no].doctorProcedureStartedIndex, 1);
    assert.equal(s.state.beds[no].doctorProcedureStartedTreatment, treatments[1]);
    assert.equal(s.state.beds[no].stageEnteredAt, 1000);
    assert.equal(s.state.beds[no].running, undefined);
    assert.deepEqual(s.state.signageCalls, []);
  });
}

test('return confirmation does not start a spine countdown or apply to a changed stage or ordinary bed', () => {
  const bed = { patientKey: 'p', treatments: ['침', '스파인'], currentIndex: 1, remaining: 900, total: 900 };
  const alert = { bedNo: 15, patientKey: 'p', returnFromWaiting: true, treatmentIndex: 1, treatmentName: '스파인' };
  assert.equal(startInitialExamOnConfirmation({ 15: bed }, alert), null);
  const changed = { ...bed, treatments: ['침', '단추'] };
  assert.equal(startInitialExamOnConfirmation({ 15: changed }, alert), null);
  assert.equal(startInitialExamOnConfirmation({ 1: changed }, { ...alert, bedNo: 1, treatmentName: '단추' }), null);
});

test('move keeps the same unconfirmed alert and publishes destination before confirmation calls signage once', async () => {
  const r = server({1:a}, {gold:{bedNo:1,patientKey:'a',timestamp:123}});
  r.move({1:{bedCleaning:true,previousPatientKey:'a'},8:a});
  assert.equal(r.state.bedAssignmentAlerts.gold.bedNo, 8);
  assert.equal(r.state.bedAssignmentAlerts.gold.timestamp, 123);
  assert.equal(r.state.signageCalls[0].bedNo, 8);
  assert.equal(r.state.signageCalls[0].pending, true);
  assert.equal(r.frames[0], 'beds');
  assert.equal(r.frames[1].key, 'bedAssignmentAlerts');
  assert.equal(signageState.publicStatus({}, r.state.beds, {}, r.state.signageCalls).active, null);
  await Promise.all([r.confirm('gold'), r.confirm('gold')]);
  assert.equal(Object.keys(r.state.bedAssignmentAlerts).length, 0);
  assert.equal(r.state.signageCalls.length, 1);
  const active = signageState.publicStatus({}, r.state.beds, {}, r.state.signageCalls).active;
  assert.equal(active.bedNo, 8);
});

test('swap, repeated move and doctor room move retain both patients pending alerts', async () => {
  const r = server({1:a,8:b}, {a:{bedNo:1,patientKey:'a'},b:{bedNo:8,patientKey:'b'}});
  r.move({1:b,8:a});
  assert.equal(r.state.bedAssignmentAlerts.a.bedNo,8);
  assert.equal(r.state.bedAssignmentAlerts.b.bedNo,1);
  r.move({1:b,101:a});
  assert.equal(r.state.bedAssignmentAlerts.a.bedNo,101);
  await r.confirm('a');
  assert.equal(signageState.publicStatus({},r.state.beds,{},r.state.signageCalls).active.bedNo,101);
  assert.equal(r.state.bedAssignmentAlerts.b.bedNo,1);
});

test('removing a patient clears alerts and moving an acknowledged patient does not recreate them', async () => {
  const r=server({1:a},{a:{bedNo:1,patientKey:'a'}});
  await r.confirm('a');
  r.move({8:a});
  assert.equal(Object.keys(r.state.bedAssignmentAlerts).length,0);
  assert.equal(r.state.signageCalls.length,0);
  assert.deepEqual(reconcileAssignmentAlerts({a:{bedNo:1,patientKey:'a'}},{}),{});
});

test('confirming a doctor room assignment after temporary holding clears the alert without calling signage', async () => {
  const r = server({8:a,101:b}, {gold:{bedNo:8,patientKey:'a'}});
  r.move({901:{...a,pendingTargetBedNo:101},101:b});
  r.move({101:a});

  assert.equal(r.state.bedAssignmentAlerts.gold.bedNo, 101);
  assert.equal(r.state.signageCalls.some(call => call.patientKey === a.patientKey), false);
  await r.confirm('gold');
  assert.equal(r.state.bedAssignmentAlerts.gold, undefined);
  assert.equal(signageState.publicStatus({}, r.state.beds, {}, r.state.signageCalls).active, null);
});

test('server clients never prune a shared alert from a partial move delta', () => {
  const c=vm.createContext({SERVER_MODE:true});
  vm.runInContext(html.slice(html.indexOf('  function pruneStaleBedAssignmentAlerts()'),html.indexOf('  async function createBedAssignmentAlert(')),c);
  // No local bed lookup or delete is permitted, even while the old bed is empty.
  c.pruneStaleBedAssignmentAlerts();
});

test('fixed and selected bed popups follow the moved alert; name click clears shared alert and calls signage', async () => {
  for (const search of ['?view=bed&bed=8', '?view=bed', '?view=bed&bed=101']) {
    const doctorBedNo = search.endsWith('bed=101') ? 101 : 0;
    const bedNo = doctorBedNo || 8;
    const r=server({1:a},{gold:{bedNo:1,patientKey:'a',patientName:a.name,visitType:'재진'}});
    r.move({[bedNo]:a});
    const classes=new Set();
    const overlay={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}};
    const name={textContent:''};
    const alerts=new Map(Object.entries(r.state.bedAssignmentAlerts));
    const timers = new Map();
    let chimes = 0;
    const [, intervalMs] = html.match(/const FIXED_DOCTOR_ROOM_ALERT_AUDIO_MS = (\d+);/);
    const c=vm.createContext({
      URLSearchParams, window:{location:{search}}, selectedBedNo:8,
      document:{getElementById:id=>id==='bedArrivalOverlay'?overlay:id==='bedArrivalName'?name:{classList:{contains:()=>true}}},
      ACTIVE_BED_NUMBERS:[1,8],getDoctorBedNumbers:()=>[101,102],getFixedDoctorBedNoFromUrl:()=>doctorBedNo,
      isFixedDoctorBedScreen:()=>Boolean(doctorBedNo),patientsByKey:new Map(),
      getBedData:no=>r.state.beds[no],bedAssignmentAlertItems:alerts,
      fixedBedArrivalAcknowledgedByBed:{},fixedBedArrivalShownByBed:{},
      fixedBedArrivalVisiblePatientKey:'',fixedBedArrivalVisibleAlertKey:'',
      maskPatientNameForBedPopup:x=>x,requestBedScreenWakeLock:()=>{},
      fixedDoctorArrivalBeepTimer:null,FIXED_DOCTOR_ROOM_ALERT_AUDIO_MS:Number(intervalMs),
      playSoftTimerChime:()=>{chimes++;},
      setInterval:(callback,delay)=>{assert.equal(delay,30000);timers.set(callback,delay);return callback;},
      clearInterval:callback=>timers.delete(callback),
      renderUpcomingAlerts:()=>{},renderBedMonitors:()=>{},renderBedSelector:()=>{},renderBedDetail:()=>{},
      updateBedHeaderBedChip:()=>{},updateBedRemainingChip:()=>{},syncDoctorProcedureAlerts:()=>{},
      removeBedAssignmentAlert:async(key,confirmed)=>{assert.equal(confirmed,true);await r.confirm(key);},
      showToast:()=>{},console
    });
    const from=html.indexOf('  function getFixedBedArrivalBedNo()');
    const to=html.indexOf('\n</script>',from);
    vm.runInContext(html.slice(from,to),c);
    c.syncFixedBedArrivalOverlay();
    assert.equal(classes.has('show'),true);
    assert.equal(name.textContent,a.name);
    assert.equal(c.isFixedBedArrivalPending(bedNo),true);
    c.syncFixedBedArrivalOverlay();
    assert.equal(chimes, doctorBedNo ? 1 : 0);
    assert.equal(timers.size, doctorBedNo ? 1 : 0);
    for (const tick of timers.keys()) {
      tick();
      tick();
    }
    assert.equal(chimes, doctorBedNo ? 3 : 0);
    await c.window.openFixedBedArrival();
    assert.equal(classes.has('show'),false);
    assert.equal(timers.size,0);
    assert.equal(c.isFixedBedArrivalPending(bedNo),false);
    assert.equal(Object.keys(r.state.bedAssignmentAlerts).length,0);
    assert.equal(signageState.publicStatus({},r.state.beds,{},r.state.signageCalls).active.bedNo,bedNo);
  }
});
