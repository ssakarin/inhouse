const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stampBedStageTimes } = require('./server/bed-stage-time');
const { startInitialExamOnConfirmation } = require('./server/bed-assignment-alerts');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const server = fs.readFileSync(`${__dirname}/server/server.js`, 'utf8');
function extract(source, name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  const start = source.slice(at - 6, at) === 'async ' ? at - 6 : at;
  const rest = source.slice(start);
  for (const match of rest.matchAll(/^\s*}\r?$/gm)) {
    const code = rest.slice(0, match.index + match[0].length);
    try { new vm.Script(code); return code; } catch {}
  }
  throw Error(`Cannot extract ${name}`);
}
const names = [
  'getTreatmentBadgeClass', 'isSimultaneousTreatment', 'getSimultaneousGroup',
  'shouldCompleteFollowingTreatmentTogether', 'getConcurrentTreatmentEndIndex',
  'getConcurrentTreatmentNames', 'formatTreatmentNames', 'normalizePreCompletedTreatmentIndexes',
  'getNextPendingTreatmentIndex', 'getRemaining', 'isDoctorProcedureTreatment',
  'getDoctorProcedureAlertId', 'getCurrentDoctorProcedureAlertId', 'isDoctorProcedureAlertDismissed',
  'normalizeTreatmentWaitThresholds', 'isDoctorProcedureInProgress', 'getDoctorProcedureWaitInfo',
  'renderLongWaitBadge', 'startDoctorProcedure', 'isLongDoctorProcedureTreatment',
  'isChunaDoctorProcedureTreatment', 'isShortDoctorProcedureTreatment', 'hasWaitingChunaDoctorProcedure',
  'getUpcomingShortDoctorProcedureInfo', 'getCleanupShortDoctorProcedureInfo',
  'buildDoctorProcedureAlertItemsAuto', 'applyDoctorAlertManualOrder', 'getDoctorProcedureAlertItems',
  'getBedAssignmentAlertForBed', 'isFixedBedArrivalPending', 'escapeHtml',
  'renderDoctorRoomAlertChips', 'renderTimerCard', 'isNoTimerTreatment',
  'shouldSubscribeLocalNode', 'refreshDoctorLongWaitDisplays', 'getWaitingPatientWaitInfo',
  'isReceiveTreatmentAlertTreatment', 'getReceiveTreatmentAlertItems'
];
function setup() {
  const clock = { now: Date.parse('2026-11-20T03:00:00Z') };
  const beds = {};
  const writes = [];
  const renders = [];
  const input = { value: '15' };
  const urgentInput = { value: '120' };
  const elements = new Map([['doctorLongWaitMinutesInput', input], ['doctorUrgentWaitMinutesInput', urgentInput]]);
  const groups = [new Set(['핫팩']), new Set(['침', '전침', '왕뜸', '전자뜸', '적외선']), new Set(['단추', '복추', '벤치'])];
  const context = vm.createContext({
    window: {}, console, Date: class extends Date { static now() { return clock.now; } },
    DEFAULT_DOCTOR_LONG_WAIT_MINUTES: 10, DEFAULT_DOCTOR_URGENT_WAIT_MINUTES: 15, doctorLongWaitMinutes: 15, doctorUrgentWaitMinutes: 15,
    selectedDoctorAlertId: 'a', ACTIVE_BED_NUMBERS: [1, 2, 3, 4, 15], HOLD_BED_NUMBERS: [901, 902],
    getDoctorBedNumbers: () => [101, 102], getBedData: no => beds[no], getBedLabel: no => String(no),
    getWaitingPatients: () => [],
    bedAssignmentAlertItems: new Map(), fixedBedArrivalAcknowledgedByBed: {},
    SIMULTANEOUS_TREATMENT_GROUPS: groups, SIMULTANEOUS_TREATMENTS: new Set(groups.flatMap(group => [...group])),
    NO_TIMER_TREATMENTS: new Set(['진찰', '베드진찰', '단추', '복추', '추나', '적외선', '테이핑', '벤치']),
    getBedTreatmentDisplayName: (bed, name) => name, renderNextStaffTaskHtml: () => '',
    getConcurrentTreatmentSeconds: () => 300, formatTimer: seconds => String(seconds),
    isDoctorReadOnlyPage: () => false, isFixedBedScreen: () => false,
    isRegularFixedBedScreen: () => false, isFixedDoctorBedScreen: () => false,
    BED_ASSIGNMENT_ALERTS_PATH: 'bedAssignmentAlerts', getDischargedPatientsPath: () => 'dischargedPatients/2026-11-20',
    lastDoctorLongWaitDisplaySignature: '',
    document: { getElementById: id => elements.get(id), querySelectorAll: () => [] },
    renderBedDoctorAlertPanel: () => renders.push('doctor'), renderWaitingLists: () => renders.push('waiting'),
    renderBedMonitors: () => renders.push('beds'), renderUpcomingAlerts: () => renders.push('alerts'),
    setLocalNode: async (key, value) => writes.push({ key, value }), showToast: () => {},
    runBedRecordTransaction: async (no, mutate) => {
      const next = mutate(structuredClone(beds[no]));
      if (next === undefined) return { committed: false };
      writes.push({ no });
      Object.assign(beds, stampBedStageTimes(beds, { ...beds, [no]: next }, clock.now));
      return { committed: true };
    }
  });
  for (const name of names) vm.runInContext(extract(html, name), context);
  const saveStart = html.indexOf('  window.saveDoctorLongWaitMinutes =');
  const saveEnd = html.indexOf('\n  };', saveStart) + 6;
  vm.runInContext(html.slice(saveStart, saveEnd), context);
  function bed(no, treatment, minutes, extra = {}) {
    return beds[no] = { patientKey: `patient-${no}`, name: `환자${no}`, doctorId: 'a',
      treatments: [treatment], currentIndex: 0, stageEnteredAt: clock.now - minutes * 60000,
      timestamp: clock.now - 60 * 60000, remaining: 300, total: 300, ...extra };
  }
  return { c: context, clock, beds, bed, writes, renders, input, elements,
    order: (id = 'a') => Array.from(context.getDoctorProcedureAlertItems(id), item => Number(item.bedNo)) };
}

test('long wait crosses the configured threshold without any persisted state change', () => {
  const s = setup();
  s.bed(101, '진찰', 14.99);
  s.bed(1, '약침1', 1);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[101]).longWaiting, false);
  assert.deepEqual(s.order(), [1, 101]);
  s.clock.now += 600;
  assert.deepEqual(s.order(), [101, 1]);
  assert.equal(s.c.getDoctorProcedureAlertItems('a')[0].waitMinutes, 15);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[101]).longWaiting, true);
  assert.equal(s.writes.length, 0);
});

test('all overdue procedures share oldest-first order, including acupuncture and pharmacopuncture 4', () => {
  const s = setup();
  s.bed(101, '진찰', 18); s.bed(1, '침', 25); s.bed(2, '약침4', 20); s.bed(3, '단추', 19);
  assert.deepEqual(s.order(), [1, 2, 3, 101]);
  s.beds[1].stageEnteredAt = s.beds[2].stageEnteredAt;
  assert.deepEqual(s.order().slice(0, 2), [1, 2]);
});

test('overdue ready procedures precede upcoming and cleanup items; unfinished preparation is not promoted', () => {
  const s = setup();
  s.bed(101, '단추', 16);
  s.bed(1, '핫팩', 30, { treatments: ['핫팩', '침'], running: true, remaining: 120 });
  s.bed(2, '침', 30, { lastAlertId: 'done-1' });
  assert.deepEqual(s.order(), [101, 2, 1]);
  assert.equal(s.c.getDoctorProcedureAlertItems('a')[2].longWaiting, undefined);
});

test('waits below the threshold preserve oldest-first ties without badges', () => {
  const s = setup(); s.bed(101, '진찰', 40); s.bed(1, '침', 1);
  s.c.doctorUrgentWaitMinutes = Infinity;
  assert.deepEqual(s.order(), [1, 101]);
  assert.equal(s.c.renderLongWaitBadge(s.c.getDoctorProcedureWaitInfo(s.beds[101])), '');
});

test('doctor ownership and arrival gates remain effective even for overdue visits', () => {
  const s = setup(); s.bed(101, '진찰', 40); s.bed(102, '추나', 50, { doctorId: 'b' }); s.bed(1, '침', 1);
  s.c.bedAssignmentAlertItems.set('arrival', { bedNo: 101, patientKey: 'patient-101' });
  assert.deepEqual(s.order(), [1]); assert.deepEqual(s.order('b'), [102]);
  s.c.bedAssignmentAlertItems.clear(); assert.deepEqual(s.order(), [101, 1]);
});

test('minute-only orange badge is shared by alert chips and bed treatment controls', () => {
  const s = setup(); s.bed(101, '진찰', 18 + 59 / 60);
  const item = s.c.getDoctorProcedureAlertItems('a')[0];
  const markup = s.c.renderDoctorRoomAlertChips(item, { includePatientName: true });
  assert.match(markup, /class="long-wait-badge"/); assert.match(markup, />18분대기</); assert.doesNotMatch(markup, /59|초/);
  const timer = s.c.renderTimerCard(101, s.beds[101], '진찰');
  assert.match(timer, /시행 시작/); assert.match(timer, /18분대기/);
});

test('running, completed, cleaning and future-dated steps are not flagged', () => {
  const s = setup();
  for (const extra of [{ running: true }, { complete: true }, { bedCleaning: true },
    { stageEnteredAt: s.clock.now + 60000 }]) {
    const record = s.bed(1, '침', 30, extra);
    assert.equal(s.c.getDoctorProcedureWaitInfo(record).longWaiting, false);
  }
});

test('starting an untimed procedure removes its waiting alert without starting a countdown', async () => {
  const s = setup(); s.bed(101, '진찰', 30); s.bed(1, '침', 1);
  await s.c.startDoctorProcedure(101);
  assert.deepEqual(s.order(), [1]); assert.equal(s.c.isDoctorProcedureInProgress(s.beds[101]), true);
  assert.equal(s.beds[101].running, undefined); assert.equal(s.beds[101].stageEnteredAt, s.clock.now - 30 * 60000);
  const markup = s.c.renderTimerCard(101, s.beds[101], '진찰');
  assert.match(markup, /시행 중/); assert.doesNotMatch(markup, /30분대기/);
  await s.c.startDoctorProcedure(101); assert.equal(s.writes.length, 1);
});

test('starting is blocked on read-only pages, holds, pending arrivals and timer-based treatments', async () => {
  const s = setup(); s.bed(101, '진찰', 30); s.bed(901, '추나', 30); s.bed(1, '침', 30);
  s.c.isDoctorReadOnlyPage = () => true; await s.c.startDoctorProcedure(101);
  s.c.isDoctorReadOnlyPage = () => false;
  await s.c.startDoctorProcedure(901); await s.c.startDoctorProcedure(1);
  s.c.bedAssignmentAlertItems.set('arrival', { bedNo: 101, patientKey: 'patient-101' });
  await s.c.startDoctorProcedure(101); assert.equal(s.writes.length, 0);
});

test('room moves and metadata edits preserve wait and in-progress status; a new step clears them', async () => {
  const s = setup(); const record = s.bed(101, '진찰', 30, { treatments: ['진찰', '약침4'] });
  await s.c.startDoctorProcedure(101);
  s.clock.now += 60000;
  const moved = stampBedStageTimes(s.beds, { 102: { ...s.beds[101], memo2: '수정' } }, s.clock.now);
  assert.equal(moved[102].stageEnteredAt, record.stageEnteredAt);
  assert.equal(s.c.isDoctorProcedureInProgress(moved[102]), true);
  const next = stampBedStageTimes(moved, { 102: { ...moved[102], currentIndex: 1 } }, s.clock.now);
  assert.equal(next[102].stageEnteredAt, s.clock.now);
  assert.equal(s.c.isDoctorProcedureInProgress(next[102]), false);
  assert.equal(next[102].doctorProcedureStartedAt, undefined);
});

test('held doctor treatments show a wait badge but do not become an actionable room recommendation', () => {
  const s = setup(); s.bed(901, '약침4', 30, { pendingTargetBedNo: 101 });
  assert.match(s.c.renderLongWaitBadge(s.c.getDoctorProcedureWaitInfo(s.beds[901])), /30분대기/);
  assert.deepEqual(s.order(), []);
  assert.doesNotMatch(s.c.renderTimerCard(901, s.beds[901], '약침4'), /시행 시작/);
});

test('clock-only display refreshes occur on threshold or minute changes, with no server writes', () => {
  const s = setup(); s.bed(101, '진찰', 14.99);
  s.c.refreshDoctorLongWaitDisplays(); s.renders.length = 0;
  s.c.refreshDoctorLongWaitDisplays(); assert.deepEqual(s.renders, []);
  s.clock.now += 600; s.c.refreshDoctorLongWaitDisplays();
  assert.deepEqual(s.renders, ['waiting', 'beds', 'alerts']); s.renders.length = 0;
  s.clock.now += 59000; s.c.refreshDoctorLongWaitDisplays(); assert.deepEqual(s.renders, []);
  s.clock.now += 1000; s.c.refreshDoctorLongWaitDisplays(); assert.equal(s.renders.length, 3);
  assert.equal(s.writes.length, 0);
});

test('threshold updates are allowed for every fixed-bed and doctor-room client', () => {
  const s = setup(); vm.runInContext(extract(server, 'sseClientAllowsState'), s.c);
  s.c.isFixedBedScreen = () => true;
  for (const doctorRoom of [false, true]) {
    s.c.isFixedDoctorBedScreen = () => doctorRoom;
    assert.equal(s.c.shouldSubscribeLocalNode('settings/treatmentWaitThresholds'), true);
    assert.equal(s.c.sseClientAllowsState({ role: doctorRoom ? 'doctor-room' : 'fixed-bed' }, 'settings/treatmentWaitThresholds'), true);
  }
});

test('single wait threshold defaults to 15, preserves existing urgent setting and rejects invalid values', async () => {
  const s = setup();
  assert.equal(s.c.normalizeTreatmentWaitThresholds(null).urgent, 15);
  assert.equal(s.c.normalizeTreatmentWaitThresholds({ priority: 10, urgent: 25 }).urgent, 25);
  for (const value of ['', '0', '-1', '10.5', '121']) {
    s.elements.get('doctorUrgentWaitMinutesInput').value = value;
    await s.c.window.saveDoctorLongWaitMinutes();
  }
  assert.equal(s.writes.length, 0);
  s.elements.get('doctorUrgentWaitMinutesInput').value = '20';
  await s.c.window.saveDoctorLongWaitMinutes();
  assert.equal(JSON.stringify(s.writes), JSON.stringify([{ key: 'settings/treatmentWaitThresholds', value: { urgent: 20 } }]));
});

test('10 minutes does not highlight or promote; 20 minutes promotes ahead of pharmacopuncture', () => {
  const s = setup(); s.c.doctorUrgentWaitMinutes = 20;
  s.bed(1, '진찰', 1, { bodyParts: { bedPreferences: { timeLimited: true } } });
  s.bed(2, '약침1', 1); s.bed(3, '왕뜸', 1); s.bed(4, '침', 19.99);
  s.bed(101, '추나', 10);
  assert.deepEqual(s.order(), [1, 2, 3, 4, 101]);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[101]).longWaiting, false);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[4]).longWaiting, false);
  s.clock.now += 600;
  assert.deepEqual(s.order(), [1, 4, 2, 3, 101]);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[4]).urgentWaiting, true);
  assert.equal(s.c.getWaitingPatientWaitInfo({ timestamp: s.clock.now - 20 * 60000 }).longWaiting, true);
  assert.equal(s.c.getWaitingPatientWaitInfo({ timestamp: s.clock.now - 10 * 60000 }).longWaiting, false);
});

test('desk and doctor alert lists preserve the procedure recommendation instead of sorting it by timestamp again', () => {
  const s = setup();
  s.bed(101, '진찰', 14.99); s.bed(1, '약침1', 1);
  s.c.getDoctorPageProcedureAlertItems = () => s.c.getDoctorProcedureAlertItems('a');
  s.c.renderSimpleDoctorProcedureAlertHtml = item => `${item.bedNo},`;
  const renderStart = html.indexOf('    const renderAlertItemsHtml =');
  const renderEnd = html.indexOf('    const getTreatmentBadgeClass =', renderStart);
  const mapStart = html.indexOf('    const scopedDoctorItems =');
  const mapEnd = html.indexOf('    const inputItems =', mapStart);
  const render = () => vm.runInContext(`(() => { ${html.slice(renderStart, renderEnd)} ${html.slice(mapStart, mapEnd)} return renderAlertItemsHtml(scopedDoctorItems); })()`, s.c);
  assert.equal(render(), '1,101,');
  s.clock.now += 600;
  assert.equal(render(), '101,1,');
});

test('reception waiting survives first assignment and arrival acknowledgment, and resets for the next treatment', () => {
  const s = setup();
  const reception = s.clock.now - 22 * 60000;
  assert.equal(s.c.getWaitingPatientWaitInfo({ timestamp: reception }).waitMinutes, 22);
  const assigned = stampBedStageTimes({}, { 101: { patientKey: 'first', doctorId: 'a', treatments: ['진찰', '침'], currentIndex: 0, timestamp: reception, waitingStageEnteredAt: reception } }, s.clock.now);
  assert.equal(assigned[101].stageEnteredAt, reception);
  assert.equal(assigned[101].waitingStageEnteredAt, undefined);
  const acknowledged = stampBedStageTimes(assigned, structuredClone(assigned), s.clock.now + 120000);
  assert.equal(acknowledged[101].stageEnteredAt, reception);
  const next = stampBedStageTimes(acknowledged, { 101: { ...acknowledged[101], currentIndex: 1 } }, s.clock.now + 180000);
  assert.equal(next[101].stageEnteredAt, s.clock.now + 180000);
});

test('manual waiting restores the pending treatment and partial remaining time on reassignment', () => {
  const s = setup();
  Object.assign(s.c, {
    getPackageStateFromPatient: () => ({}), getPCreditsFromPackages: () => ({}),
    normalizeChartNo: value => value || '', normalizeMemo2History: () => ({}),
    lightenVisitHistoryForBoard: value => value, getVisitGoal: () => '', normalizeVisitCountAdjustment: () => 0
  });
  vm.runInContext(extract(html, 'createBedAssignment'), s.c);
  const since = s.clock.now - 24 * 60000;
  const patient = { name: '복귀', timestamp: s.clock.now, bedStatus: 'waiting', treatments: ['침', '단추'],
    waitingStage: { treatments: ['침', '단추'], currentIndex: 1, remaining: 120, stageEnteredAt: since, preCompletedTreatmentIndexes: [0] } };
  const assignment = s.c.createBedAssignment('returning', patient, 101);
  assert.equal(assignment.currentIndex, 1);
  assert.equal(assignment.remaining, 120);
  assert.equal(assignment.waitingStageEnteredAt, since);
  assert.equal(s.c.getWaitingPatientWaitInfo(patient).waitMinutes, 24);
  const resumed = stampBedStageTimes({}, { 101: assignment }, s.clock.now);
  assert.equal(s.c.getDoctorProcedureWaitInfo(resumed[101]).waitMinutes, 24);
  patient.treatments = ['진찰'];
  assert.equal(s.c.createBedAssignment('returning', patient, 101).currentIndex, 0);
});

function loadAssignment(s) {
  Object.assign(s.c, {
    getPackageStateFromPatient: () => ({}), getPCreditsFromPackages: () => ({}),
    normalizeChartNo: value => value || '', normalizeMemo2History: () => ({}),
    lightenVisitHistoryForBoard: value => value, getVisitGoal: () => '', normalizeVisitCountAdjustment: () => 0
  });
  vm.runInContext(extract(html, 'createBedAssignment'), s.c);
}

for (const [no, treatment, index, returned] of [
  [101, '진찰', 0, false], [1, '베드진찰', 0, false],
  [101, '약침4', 1, true], [15, '단추', 1, true]
]) test(`full wait audit: ${treatment} popup ends overdue state until completion, then a fresh 15-minute wait`, () => {
  const s = setup();
  const treatments = index ? ['침', treatment, '핫팩'] : [treatment, '핫팩'];
  s.bed(no, treatment, 20, { treatments, currentIndex: index, initialExamOnArrival: !returned });
  const alert = { bedNo: no, patientKey: `patient-${no}`, ...(returned ? {
    returnFromWaiting: true, treatmentIndex: index, treatmentName: treatment
  } : {}) };
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).longWaiting, true);
  const started = startInitialExamOnConfirmation(s.beds, alert, s.clock.now);
  assert.ok(started);
  const committed = stampBedStageTimes(s.beds, started, s.clock.now);
  Object.assign(s.beds, committed);
  s.clock.now += 30 * 60000;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).longWaiting, false);
  assert.deepEqual(s.order(), []);
  const next = stampBedStageTimes(s.beds, { [no]: { ...s.beds[no], currentIndex: index + 1, remaining: 300 } }, s.clock.now);
  Object.assign(s.beds, next);
  s.clock.now += 15 * 60000 - 1;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).longWaiting, false);
  s.clock.now += 1;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).longWaiting, true);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).waitMinutes, 15);
});

for (const treatment of ['진찰', '단추', '약침4', '적외선', '테이핑', '벤치']) {
  for (const withStart of [false, true]) test(`${treatment}: completion advances with optional start=${withStart}`, async () => {
    const s = setup();
    s.bed(1, treatment, 20, { treatments: [treatment, '핫팩'] });
    s.c.updateBedRecord = async (no, patch) => Object.assign(s.beds, stampBedStageTimes(s.beds, { ...s.beds, [no]: { ...s.beds[no], ...patch } }, s.clock.now));
    s.c.maybeAutoMoveBedForNextTreatment = async () => {};
    s.c.clearLocalTimerAlertsForBed = () => {};
    const start = html.indexOf('  window.completeNoTimerTreatment =');
    vm.runInContext(html.slice(start, html.indexOf('  function parseTimerEditSeconds', start)), s.c);
    assert.match(s.c.renderTimerCard(1, s.beds[1], treatment), /시행 시작/);
    if (withStart) {
      await s.c.startDoctorProcedure(1);
      assert.equal(s.c.isDoctorProcedureInProgress(s.beds[1]), true);
      assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[1]).longWaiting, false);
      assert.deepEqual(Array.from(s.c.getReceiveTreatmentAlertItems()), []);
    }
    await s.c.window.completeNoTimerTreatment(1);
    assert.equal(s.beds[1].currentIndex, 1);
    assert.equal(s.beds[1].complete, false);
    assert.equal(s.c.isDoctorProcedureInProgress(s.beds[1]), false);
    await s.c.window.completeNoTimerTreatment(1);
    assert.equal(s.beds[1].complete, true);
  });
}

test('nurse treatment starts are flagged without adding them to the doctor procedure queue', () => {
  const s = setup();
  for (const treatment of ['핫팩', '물리치료', '적외선', '스파인', '테이핑']) {
    s.bed(1, treatment, 15);
    assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[1]).longWaiting, true);
    assert.deepEqual(s.order(), []);
  }
});

test('started timer remains outside waiting while paused; next stage gets a fresh wait', () => {
  const s = setup();
  s.bed(1, '핫팩', 30, { treatments: ['핫팩', '침'] });
  const running = stampBedStageTimes(s.beds, { 1: { ...s.beds[1], running: true,
    timerStageStarted: { index: 0, treatment: '핫팩' } } }, s.clock.now);
  s.clock.now += 20 * 60000;
  const paused = stampBedStageTimes(running, { 1: { ...running[1], running: false, startedAt: null, remaining: 180 } }, s.clock.now);
  assert.equal(s.c.getDoctorProcedureWaitInfo(paused[1]).longWaiting, false);
  const next = stampBedStageTimes(paused, { 1: { ...paused[1], currentIndex: 1, remaining: 300 } }, s.clock.now);
  assert.equal(next[1].timerStageStarted, undefined);
  s.clock.now += 15 * 60000;
  assert.equal(s.c.getDoctorProcedureWaitInfo(next[1]).longWaiting, true);
});

test('requested case 1: reception waiting crosses 15 minutes without a bed or a write', () => {
  const s = setup();
  const patient = { timestamp: s.clock.now };
  s.clock.now += 899999;
  assert.equal(s.c.getWaitingPatientWaitInfo(patient).longWaiting, false);
  s.clock.now += 1;
  assert.equal(s.c.getWaitingPatientWaitInfo(patient).longWaiting, true);
  assert.match(s.c.renderLongWaitBadge(s.c.getWaitingPatientWaitInfo(patient)), /15분대기/);
  assert.equal(s.writes.length, 0);
});

for (const no of [1, 101]) test(`requested case ${no === 1 ? 2 : 3}: reception 10 minutes + unacknowledged arrival 5 minutes at ${no}`, () => {
  const s = setup(); loadAssignment(s);
  const reception = s.clock.now;
  s.clock.now += 10 * 60000;
  const assignment = s.c.createBedAssignment('new', { name: '초진', doctorId: 'a', timestamp: reception, treatments: ['진찰'] }, no);
  Object.assign(s.beds, stampBedStageTimes({}, { [no]: assignment }, s.clock.now));
  s.c.bedAssignmentAlertItems.set('arrival', { bedNo: no, patientKey: 'new' });
  s.clock.now += 5 * 60000;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).waitMinutes, 15);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[no]).longWaiting, true);
  assert.deepEqual(s.order(), []);
  s.c.bedAssignmentAlertItems.clear();
  assert.deepEqual(s.order(), [no]);
  assert.equal(s.c.getDoctorProcedureAlertItems('a')[0].waitMinutes, 15);
});

for (const treatment of ['침', '단추', '약침4', '스파인']) test(`requested cases 4 and 5: completed prior procedure -> ${treatment}, waiting stays continuous through a hold`, async () => {
  const s = setup();
  s.bed(1, '진찰', 25, { treatments: ['진찰', treatment] });
  s.c.updateBedRecord = async (no, patch) => Object.assign(s.beds, stampBedStageTimes(s.beds, { ...s.beds, [no]: { ...s.beds[no], ...patch } }, s.clock.now));
  s.c.maybeAutoMoveBedForNextTreatment = async () => {};
  s.c.clearLocalTimerAlertsForBed = () => {};
  const start = html.indexOf('  window.completeNoTimerTreatment =');
  vm.runInContext(html.slice(start, html.indexOf('  function parseTimerEditSeconds', start)), s.c);
  const endedAt = s.clock.now;
  await s.c.window.completeNoTimerTreatment(1);
  assert.equal(s.beds[1].currentIndex, 1);
  assert.equal(s.beds[1].stageEnteredAt, endedAt);
  s.clock.now += 10 * 60000;
  const held = stampBedStageTimes(s.beds, { 901: { ...s.beds[1], pendingTargetBedNo: treatment === '스파인' ? 15 : 101, holdQueuedAt: s.clock.now } }, s.clock.now);
  delete s.beds[1]; Object.assign(s.beds, held);
  s.clock.now += 5 * 60000;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[901]).waitMinutes, 15);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[901]).longWaiting, true);
  assert.deepEqual(s.order(), []);
  const target = treatment === '스파인' ? 15 : 101;
  const released = stampBedStageTimes(s.beds, { [target]: { ...s.beds[901], pendingTargetBedNo: null } }, s.clock.now);
  delete s.beds[901]; Object.assign(s.beds, released);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[target]).waitMinutes, 15);
  assert.deepEqual(s.order(), treatment === '스파인' ? [] : [target]);
});

test('desk and doctor page rendering preserves the recommended procedure order and other alert positions', () => {
  const s = setup();
  const start = html.indexOf('    const renderAlertItemsHtml =');
  const end = html.indexOf('    const getTreatmentBadgeClass =', start);
  vm.runInContext(html.slice(start, end) + '\nglobalThis.renderAlertItemsForTest = renderAlertItemsHtml;', s.c);
  const items = [
    { html: 'exam', timestamp: 100, doctorProcedureOrder: 1 },
    { html: 'call', timestamp: 150 },
    { html: 'overdue', timestamp: 200, doctorProcedureOrder: 0 },
    { html: 'needle', timestamp: 300, doctorProcedureOrder: 2 },
    { html: 'appointment', timestamp: 400, alertPriority: 0 }
  ];
  assert.equal(s.c.renderAlertItemsForTest(items), 'appointmentoverduecallexamneedle');
});


test('time check precedes overdue, pharmacopuncture 1/2, standalone cupping/moxa and other treatments', () => {
  const s = setup();
  s.bed(1, '진찰', 1, { bodyParts: { bedPreferences: { timeLimited: true } } });
  s.bed(2, '추나', 25);
  s.bed(3, '약침2', 2);
  s.bed(4, '왕뜸', 10);
  s.bed(101, '침', 14);
  assert.deepEqual(s.order(), [1, 2, 3, 4, 101]);
});

test('configured threshold controls promotion independently of time checks', () => {
  const s = setup();
  s.bed(1, '침', 10); s.bed(2, '진찰', 12);
  s.bed(4, '약침1', 1);
  s.bed(3, '추나', 0, { bodyParts: { bedPreferences: { timeLimited: true } } });
  s.c.doctorUrgentWaitMinutes = 10;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[1]).longWaiting, true);
  assert.deepEqual(s.order(), [3, 2, 1, 4]);
  s.c.doctorUrgentWaitMinutes = 13;
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[1]).longWaiting, false);
  assert.deepEqual(s.order(), [3, 4, 1, 2]);
  s.c.doctorUrgentWaitMinutes = Infinity;
  assert.deepEqual(s.order(), [3, 4, 1, 2]);
});

test('only current pharmacopuncture 1/2 and standalone cupping/moxa receive treatment priority', () => {
  const s = setup(); s.c.doctorUrgentWaitMinutes = Infinity;
  s.bed(1, '침', 12, { treatments: ['침', '약침1'] });
  s.bed(2, '약침4', 11);
  s.bed(3, '왕뜸', 10, { treatments: ['왕뜸', '침'] });
  s.bed(4, '습부항', 1);
  s.bed(101, '약침1', 0);
  assert.deepEqual(s.order(), [101, 4, 1, 3, 2]);
  for (const name of ['건부항', '전자뜸']) {
    s.beds[4].treatments = [name];
    assert.deepEqual(s.order(), [101, 4, 1, 3, 2]);
  }
});

test('preparation precedes long treatments; upcoming uses shortest remaining first', () => {
  const s = setup();
  const urgent = { bodyParts: { bedPreferences: { timeLimited: true } } };
  s.bed(101, '추나', 1);
  s.bed(1, '침', 40, { ...urgent, lastAlertId: 'done-1' });
  s.bed(2, '핫팩', 40, { ...urgent, treatments: ['핫팩', '약침1'], running: true, remaining: 120 });
  s.bed(3, '핫팩', 40, { treatments: ['핫팩', '침'], running: true, remaining: 60 });
  s.bed(4, '침', 0);
  assert.deepEqual(s.order(), [4, 1, 3, 2, 101]);
  s.beds[2].remaining = 121;
  assert.deepEqual(s.order(), [4, 1, 3, 101]);
  s.beds[2].remaining = 119;
  assert.deepEqual(s.order(), [4, 1, 3, 2, 101]);
  s.beds[101].stageEnteredAt = s.clock.now - 15 * 60000;
  assert.deepEqual(s.order(), [101, 4, 1, 3, 2]);
});


test('simulation: 습부항 completion -> manual waiting -> doctor room -> popup confirmation with 복추 SW 약침4 remaining', async () => {
  const s = setup(); loadAssignment(s);
  const patients = new Map();
  const timeline = [];
  const snapshot = (label, bed, waiting = false) => {
    const info = waiting ? s.c.getWaitingPatientWaitInfo(bed) : s.c.getDoctorProcedureWaitInfo(bed);
    timeline.push({step: label, treatment: waiting ? bed.treatments[bed.waitingStage.currentIndex] : bed.treatments[bed.currentIndex],
      waitMinutes: info.waitMinutes, longWaiting: info.longWaiting,
      previousAlert: Boolean(bed.lastAlertId), inProgress: s.c.isDoctorProcedureInProgress(bed)});
    return info;
  };
  function commit(next) {
    const stamped = stampBedStageTimes(s.beds, next, s.clock.now);
    for (const no of Object.keys(s.beds)) delete s.beds[no];
    Object.assign(s.beds, stamped);
  }
  Object.assign(s.c, {
    finishingBeds: new Set(), queuedTimerAlerts: new Set(), seenTimerAlerts: new Set(),
    showTimerCompleteAlert: () => {}, clearLocalTimerAlertsForBed: () => {},
    patientsByKey: patients, isCleaningBed: bed => Boolean(bed?.bedCleaning),
    updatePatient: async (key, patch) => patients.set(key, {...patients.get(key), ...patch}),
    removeBedRecord: async no => { const next = {...s.beds}; delete next[no]; commit(next); },
    runBedsRecordTransaction: async mutate => {
      const next = mutate(structuredClone(s.beds));
      if (next === undefined) return {committed:false,snapshot:{val:()=>s.beds}};
      commit(next); return {committed:true,snapshot:{val:()=>s.beds}};
    },
    applyRoundRobinNurse: async (key, data) => data,
    getBedAssignmentAlertForPatient: key => [...s.c.bedAssignmentAlertItems.entries()]
      .map(([key, alert])=>({key,...alert})).find(a=>a.patientKey===key),
    pushBedAssignmentAlert: async alert => s.c.bedAssignmentAlertItems.set('gold', alert),
    updateLocalNodeChild: async () => { throw Error('unexpected existing alert'); }
  });
  for (const name of ['finishBedStep', 'createBedAssignmentAlert', 'assignWaitingPatientToSpecificBed'])
    vm.runInContext(extract(html, name), s.c);
  const moveStart = html.indexOf('  window.moveBedToWaiting =');
  vm.runInContext(html.slice(moveStart, html.indexOf('  window.handleInputBedClick =', moveStart)), s.c);
  s.bed(1, '습부항', 5, {treatments:['습부항','복추','SW','약침4'], running:true, remaining:0});
  await s.c.finishBedStep(1);
  assert.equal(s.beds[1].currentIndex, 1);
  assert.ok(s.beds[1].lastAlertId);
  snapshot('습부항 완료, 완료 알림 미확인', s.beds[1]);
  s.clock.now += 2 * 60000;
  await s.c.window.moveBedToWaiting(1);
  const patient = patients.get('patient-1');
  assert.equal(s.beds[1], undefined);
  assert.equal(patient.lastAlertId, undefined);
  snapshot('간호사가 수동 대기실 이동', patient, true);
  s.clock.now += 18 * 60000;
  assert.equal(snapshot('대기실 18분 경과', patient, true).waitMinutes, 20);
  assert.equal(await s.c.assignWaitingPatientToSpecificBed('patient-1', 101), true);
  assert.equal(s.beds[101].currentIndex, 1);
  assert.equal(s.beds[101].lastAlertId, undefined);
  assert.equal(snapshot('원장실 재배정, 팝업 미확인', s.beds[101]).waitMinutes, 20);
  const alert = s.c.bedAssignmentAlertItems.get('gold');
  assert.ok(alert);
  assert.equal(alert.returnFromWaiting, true);
  assert.equal(alert.treatmentIndex, 1);
  assert.equal(alert.treatmentName, '복추');
  s.clock.now += 5 * 60000;
  assert.equal(snapshot('팝업 확인 직전', s.beds[101]).waitMinutes, 25);
  const confirmed = startInitialExamOnConfirmation(s.beds, alert, s.clock.now);
  assert.ok(confirmed);
  commit(confirmed);
  s.c.bedAssignmentAlertItems.delete('gold');
  assert.equal(snapshot('팝업 확인 직후', s.beds[101]).waitMinutes, 0);
  assert.equal(s.c.isDoctorProcedureInProgress(s.beds[101]), true);
  s.clock.now += 20 * 60000;
  assert.equal(snapshot('확인 후 20분 경과', s.beds[101]).longWaiting, false);
  assert.equal(s.c.getDoctorProcedureWaitInfo(s.beds[101]).waitMinutes, 0);
  console.log('Manual return simulation:', JSON.stringify(timeline));
});


test('long treatments follow other ready treatments but retain time-check and overdue promotion', () => {
  const s = setup(); s.c.doctorUrgentWaitMinutes = 15;
  s.bed(1, '진찰', 10); s.bed(2, '추나', 9); s.bed(3, '약침4', 8);
  s.bed(4, '침', 1); s.bed(101, '전침', 2);
  assert.deepEqual(s.order(), [101, 4, 1, 2, 3]);
  s.beds[3].stageEnteredAt = s.clock.now - 15 * 60000;
  s.beds[2].bodyParts = { bedPreferences: { timeLimited: true } };
  assert.deepEqual(s.order(), [2, 3, 101, 4, 1]);
  for (const treatment of ['베드진찰', '단추', '복추']) {
    s.beds[1].treatments = [treatment];
    assert.deepEqual(s.order(), [2, 3, 101, 4, 1]);
  }
});
