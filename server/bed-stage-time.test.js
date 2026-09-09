const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stampBedStageTimes } = require('./bed-stage-time');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const alertBuilder = html.slice(html.indexOf('  function buildDoctorProcedureAlertItemsAuto('), html.indexOf('  function getDoctorProcedureAlertItems('));
function alertOrder(beds, assignmentAlerts = new Map(), nurse = false) {
  const context = {
    selectedDoctorAlertId: 'doctor', getDoctorBedNumbers: () => [],
    ACTIVE_BED_NUMBERS: Object.keys(beds), getBedData: n => beds[n],
    bedAssignmentAlertItems: assignmentAlerts, fixedBedArrivalAcknowledgedByBed: {},
    getCleanupShortDoctorProcedureInfo: () => null,
    getUpcomingShortDoctorProcedureInfo: () => null,
    getConcurrentTreatmentNames: (ts, i) => [ts[i]], formatTreatmentNames: ts => ts.join(','),
    isDoctorProcedureTreatment: t => t === '침', isShortDoctorProcedureTreatment: t => t === '침',
    getDoctorProcedureAlertId: n => n, isDoctorProcedureAlertDismissed: () => false,
    getBedLabel: n => n
  };
  vm.createContext(context);
  const arrival = html.slice(html.indexOf('  function getBedAssignmentAlertForBed(bedNo)'), html.indexOf('  async function removeBedAssignmentAlertForBedPatient('));
  const receive = html.slice(html.indexOf('  function isReceiveTreatmentAlertTreatment('), html.indexOf('  function syncAssignedPatientKeys('));
  return Array.from(vm.runInContext(`${arrival}\n${receive}\n${alertBuilder}\n${nurse ? 'getReceiveTreatmentAlertItems()' : 'buildDoctorProcedureAlertItemsAuto()'}.map(x => x.name)`, context));
}
const patient = (name, timestamp) => ({ patientKey: name, name, timestamp, doctorId: 'doctor', treatments: ['핫팩', '물리치료', '침'], currentIndex: 1, running: false });

test('B finishes first; A acknowledgment first and later B acknowledgment retain B → A', () => {
  const initial = { 1: patient('A', 100), 2: patient('B', 200) };
  const bDone = stampBedStageTimes(initial, { ...initial, 2: { ...initial[2], currentIndex: 2, lastAlertId: 'B-1-1000' } }, 1000);
  const bothDone = stampBedStageTimes(bDone, { ...bDone, 1: { ...bDone[1], currentIndex: 2, lastAlertId: 'A-1-2000' } }, 2000);
  const aAck = stampBedStageTimes(bothDone, { ...bothDone, 1: { ...bothDone[1], lastAlertId: null } }, 3000);
  const bothAck = stampBedStageTimes(aAck, { ...aAck, 2: { ...aAck[2], lastAlertId: null } }, 4000);
  assert.equal(bothAck[2].stageEnteredAt, 1000);
  assert.equal(bothAck[1].stageEnteredAt, 2000);
  assert.deepEqual(alertOrder(JSON.parse(JSON.stringify(bothAck))), ['B', 'A']);
  const moved = stampBedStageTimes(bothAck, { 1: bothAck[1], 3: bothAck[2] }, 5000);
  assert.equal(moved[3].stageEnteredAt, 1000);
  assert.deepEqual(alertOrder(moved), ['B', 'A']);
});

test('first stage starts at assignment, later stages get fresh times', () => {
  const assigned = stampBedStageTimes({}, { 1: { ...patient('A', 100), currentIndex: 2 } }, 1000);
  assert.equal(assigned[1].stageEnteredAt, 1000);
  const changed = stampBedStageTimes(assigned, { 1: { ...assigned[1], currentIndex: 1 } }, 2000);
  assert.equal(changed[1].stageEnteredAt, 2000);
});

test('late timer reports use the actual timer deadline', () => {
  const old = { 1: { ...patient('A', 100), running: true, startedAt: 1000, remaining: 10 } };
  const next = stampBedStageTimes(old, { 1: { ...old[1], running: false, startedAt: null, currentIndex: 2, lastAlertId: 'A-1-15000' } }, 15000);
  assert.equal(next[1].stageEnteredAt, 11000);
});

test('legacy unacknowledged completion survives acknowledgment', () => {
  const old = { 1: { ...patient('A', 100), currentIndex: 2, lastAlertId: 'A-1-1000' } };
  const next = stampBedStageTimes(old, { 1: { ...old[1], lastAlertId: null } }, 2000);
  assert.equal(next[1].stageEnteredAt, 1000);
});

test('first procedure uses assignment time; shared arrival alert gates doctor and nurse lists', () => {
  const beds = stampBedStageTimes({}, {
    1: { ...patient('A', 100), treatments: ['침'], currentIndex: 0 },
    2: { ...patient('B', 200), treatments: ['핫팩', '침'], currentIndex: 0 }
  }, 1000);
  const alerts = new Map([
    ['arrival-a', { bedNo: 1, patientKey: 'A', timestamp: 1000 }],
    ['arrival-b', { bedNo: 2, patientKey: 'B', timestamp: 1000 }]
  ]);
  assert.equal(beds[1].stageEnteredAt, 1000);
  assert.deepEqual(alertOrder(beds, alerts), []);
  assert.deepEqual(alertOrder(beds, alerts, true), []);
  alerts.delete('arrival-a');
  assert.deepEqual(alertOrder(beds, alerts), ['A']);
  assert.deepEqual(alertOrder(beds, alerts, true), []);
  alerts.delete('arrival-b');
  assert.deepEqual(alertOrder(beds, alerts, true), ['B']);
  assert.equal(beds[1].stageEnteredAt, 1000);
});
