const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const server = fs.readFileSync(`${__dirname}/server/server.js`, 'utf8');

function extract(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.ok(functionStart >= 0, name);
  const start = source.slice(functionStart - 6, functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const rest = source.slice(start);
  for (const match of rest.matchAll(/^\s*}\r?$/gm)) {
    const code = rest.slice(0, match.index + match[0].length);
    try { new vm.Script(code); return code; } catch {}
  }
  throw Error(`Cannot extract ${name}`);
}
function load(context, source, names) {
  for (const name of names) vm.runInContext(extract(source, name), context);
}
function pageContext() {
  const doctors = new Map([['a', { name: '허진혁' }], ['b', { name: '김상준' }]]);
  const beds = { 1: { doctorId: 'a', name: '담당환자' }, 2: { doctorId: 'b', name: '다른환자' } };
  const elements = new Map();
  const context = vm.createContext({
    page: 'doctor', doctorPageFilterId: 'a', staffByType: { doctors },
    patientsByKey: new Map([['pa', beds[1]], ['pb', beds[2]]]),
    getBedData: no => beds[no], getSortedStaff: () => [...doctors],
    getDoctorProcedureAlertItems: id => [{ doctorId: id, name: `${id}알림` }],
    document: { getElementById: id => elements.get(id) },
    escapeHtml: value => String(value), window: { currentMode: 'input' },
  });
  context.getAppView = () => context.page;
  load(context, html, ['getDoctorPageFilter', 'matchesDoctorIdentity', 'matchesDoctorPageRecord', 'canUseDoctorPageBed', 'getDoctorPageProcedureAlertItems']);
  return { context, beds, elements };
}

test('doctor selection matches IDs first, legacy names second, and excludes unassigned records', () => {
  const { context: c } = pageContext();
  assert.equal(c.matchesDoctorPageRecord({ doctorId: 'a', doctorName: '옛 이름' }), true);
  assert.equal(c.matchesDoctorPageRecord({ doctorId: 'b', doctorName: '허진혁' }), false);
  assert.equal(c.matchesDoctorPageRecord({ doctorName: ' 허진혁 ' }), true);
  assert.equal(c.matchesDoctorPageRecord({}), false);
  assert.equal(c.matchesDoctorPageRecord({ bedNo: 1 }), true);
  assert.equal(c.matchesDoctorPageRecord({ patientKey: 'pb' }), false);
  c.doctorPageFilterId = '';
  assert.equal(c.matchesDoctorPageRecord({}), true);
  assert.equal(c.matchesDoctorPageRecord({ doctorId: 'b' }), true);
  c.doctorPageFilterId = 'a';
  c.page = 'desk';
  assert.equal(c.matchesDoctorPageRecord({ doctorId: 'b' }), true);
});

test('bed information can be viewed across doctors without changing the selected filter', () => {
  const { context: c, elements, beds } = pageContext();
  for (const id of ['doctorPatientViewTitle', 'doctorPatientViewBody', 'doctorPatientViewOverlay']) elements.set(id, { classList: { add() {} } });
  load(c, html, ['showDoctorPatientView']);
  c.showDoctorPatientView(beds[2], '2번', true);
  assert.match(elements.get('doctorPatientViewTitle').textContent, /다른환자/);
  assert.equal(c.getDoctorPageFilter().id, 'a');
});

test('procedure alerts and today counts follow the same doctor selection', () => {
  const { context: c, elements, beds } = pageContext();
  Object.assign(c, {
    isRegularFixedBedScreen: () => false, isFixedDoctorBedScreen: () => false,
    loadedKeys: new Set(), dischargedPatientsByKey: new Map([['one', beds[1]], ['two', beds[2]]]),
    REGULAR_BED_NUMBERS: [1, 2, 3], REGULAR_BED_COUNT: 3, bedAssignments: [beds[1], beds[2], null],
  });
  elements.set('deskTodayTreatedCount', {});
  elements.set('deskBedPatientCount', {});
  load(c, html, ['updateCount']);
  c.updateCount();
  assert.equal(elements.get('deskTodayTreatedCount').textContent, '오늘 1명 · 전체 2명');
  assert.equal(elements.get('deskBedPatientCount').textContent, '1/3');
  assert.deepEqual(Array.from(c.getDoctorPageProcedureAlertItems(), item => item.doctorId), ['a']);
  c.doctorPageFilterId = 'b';
  assert.deepEqual(Array.from(c.getDoctorPageProcedureAlertItems(), item => item.doctorId), ['b']);
  c.doctorPageFilterId = '';
  c.updateCount();
  assert.equal(elements.get('deskTodayTreatedCount').textContent, '오늘 2명');
  assert.deepEqual(Array.from(c.getDoctorPageProcedureAlertItems(), item => item.doctorId), ['a', 'b']);
});

test('editing an assigned patient preserves the selected doctor while away', () => {
  const { context: c, elements } = pageContext();
  elements.set('doctorSelect', { value: 'a' });
  c.isDoctorUnavailable = () => true;
  load(c, html, ['getSelectedStaff']);
  assert.equal(c.getSelectedStaff('doctors').id, 'a');
  c.page = 'desk';
  assert.equal(c.getSelectedStaff('doctors').id, '');
});

test('appointment and call alerts resolve patient ownership instead of mixing doctors', () => {
  const { context: c } = pageContext();
  Object.assign(c, {
    appointmentDeskAlertItems: new Map([
      ['aa', { patientKey: 'pa', name: '예약A', dates: ['2026-11-01'] }],
      ['bb', { patientKey: 'pb', name: '예약B', dates: ['2026-11-01'] }],
    ]),
    callAlertItems: new Map([
      ['ca', { doctorId: 'a', target: 'desk', message: '호출A' }],
      ['cb', { doctorId: 'b', target: 'desk', message: '호출B' }],
    ]),
    normalizeAppointmentDates: value => Array.isArray(value) ? value : [],
    shouldShowUndecidedAlertForMode: () => false,
  });
  load(c, html, ['getVisibleAppointmentAlertItems', 'getVisibleCallAlertItems']);
  assert.deepEqual(Array.from(c.getVisibleAppointmentAlertItems(), item => item.name), ['예약A']);
  assert.deepEqual(Array.from(c.getVisibleCallAlertItems(), item => item.message), ['호출A']);
  c.doctorPageFilterId = '';
  assert.equal(c.getVisibleAppointmentAlertItems().length, 2);
  assert.equal(c.getVisibleCallAlertItems().length, 2);
});

test('appointment badge and calendar counts are computed from the selected doctor only', () => {
  const { context: c } = pageContext();
  load(c, html, ['filterDoctorPageAppointmentGroups', 'formatDoctorAppointmentCount']);
  const groups = [{ date: '2026-10-31', count: 3, visitedCount: 2, patients: [
    { doctorId: 'a', attended: true }, { doctorId: 'a', attended: false }, { doctorId: 'b', attended: true },
  ] }];
  const own = c.filterDoctorPageAppointmentGroups(groups);
  assert.equal(own[0].count, 2);
  assert.equal(own[0].visitedCount, 1);
  assert.equal(c.formatDoctorAppointmentCount(own[0]), '예약 1/2명 · 전체 2/3명');
  c.doctorPageFilterId = '';
  assert.equal(c.filterDoctorPageAppointmentGroups(groups)[0].count, 3);
  assert.equal(c.formatDoctorAppointmentCount(groups[0]), '예약 2/3명');
});

function weeklyContext() {
  const records = [
    { patientId: 'p1', doctorName: '김상준', visitHistory: {
      '2026-10-20': { doctorName: '허진혁', visitType: '초진', treatments: ['복추'] },
      '2026-10-21': { doctorName: '김상준', visitType: '재진', treatments: ['침'] },
      '2026-10-22': { doctorName: '허진혁', visitType: '재진', treatments: ['단추'] },
    } },
    { patientId: 'p2', doctorName: '김상준', visitHistory: {
      '2026-10-23': { visitType: '초진', treatments: ['침'] },
    } },
    { patientId: 'p3', doctorName: '허진혁', visitHistory: {
      '2026-10-24': { visitType: '초진', chiefComplaint: '처방', treatments: [] },
    } },
    { patientId: 'p4', doctorName: '김상준', visitHistory: {
      '2026-10-10': { doctorName: '허진혁', visitType: '초진', treatments: ['복추'] },
      '2026-10-11': { doctorName: '김상준', visitType: '재진', treatments: ['침'] },
      '2026-10-12': { doctorName: '김상준', visitType: '재진', treatments: ['침'] },
    } },
  ];
  const context = vm.createContext({
    patientCache: new Map(records.map(record => [record.patientId, record])),
    ensurePatientCache: () => {}, getLocalDateKey: () => '2026-10-31',
    ymd: date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    normalizeTreatmentStatName: name => name,
    DESK_WEEKLY_WIDGET_CACHE_MS: 300000, deskWeeklyWidgetCache: null, patientDataRevision: 1,
  });
  load(context, server, ['normalizeSearchText', 'addDays', 'visitDatesOf', 'isPrescriptionChiefComplaint', 'isPrescriptionVisit', 'normalizeVisitType', 'getVisitRecord', 'explicitNewVisitDatesOf', 'newVisitDatesOf', 'nonPrescriptionVisitDatesOf', 'isSimpleChunaTreatment', 'isComplexChunaTreatment', 'computeDeskWeeklyWidget', 'getDeskWeeklyWidget']);
  return context;
}

test('weekly metrics use the visit doctor and attribute retention to the initial doctor', () => {
  const c = weeklyContext();
  const a = c.computeDeskWeeklyWidget(14, '허진혁');
  const b = c.computeDeskWeeklyWidget(14, '김상준');
  const all = c.computeDeskWeeklyWidget(14);
  assert.equal(a.current.visits, 2);
  assert.equal(a.current.chunaVisits, 2);
  assert.equal(a.current.newPatients, 1);
  assert.equal(a.current.thirdVisitPatients, 1);
  assert.equal(a.comparison.newPatients, 1);
  assert.equal(a.comparison.thirdVisitPatients, 1);
  assert.equal(b.current.visits, 2);
  assert.equal(b.current.chunaVisits, 0);
  assert.equal(b.current.newPatients, 1);
  assert.equal(b.current.thirdVisitPatients, 0);
  assert.equal(all.current.visits, a.current.visits + b.current.visits);
  assert.equal(all.current.newPatients, 2);
  assert.equal(all.current.clinicDays, 4);
});

test('weekly cache never returns another doctor or range', () => {
  const c = weeklyContext();
  assert.equal(c.getDeskWeeklyWidget(14, '허진혁').doctor, '허진혁');
  assert.equal(c.getDeskWeeklyWidget(14, '김상준').current.chunaVisits, 0);
  assert.equal(c.getDeskWeeklyWidget(14, '허진혁').current.chunaVisits, 2);
  assert.equal(c.getDeskWeeklyWidget(7, '허진혁').rangeDays, 7);
  assert.equal(c.getDeskWeeklyWidget(14).current.chunaVisits, 2);
});

test('late weekly responses cannot overwrite the newly selected doctor', async () => {
  const pending = [];
  const rendered = [];
  let doctor = { name: '허진혁' };
  const element = { classList: { add() {}, remove() {} } };
  const c = vm.createContext({
    location: { protocol: 'http:' }, URLSearchParams, deskWeeklyRequestId: 0, deskWeeklyRangeDays: 14,
    window: { getDoctorPageFilter: () => doctor }, getAppView: () => 'doctor',
    document: { getElementById: () => element }, setDeskWeeklyDirection() {},
    renderDeskWeeklyWidget: data => rendered.push(data.doctor),
    fetch: url => new Promise(resolve => pending.push({ url, resolve })),
  });
  vm.runInContext(extract(html, 'refreshDeskWeeklyWidget'), c);
  const first = c.refreshDeskWeeklyWidget();
  doctor = { name: '김상준' };
  const second = c.refreshDeskWeeklyWidget();
  assert.equal(new URL(pending[0].url, 'http://localhost').searchParams.get('doctor'), '허진혁');
  pending[1].resolve({ ok: true, json: async () => ({ doctor: '김상준' }) });
  await second;
  pending[0].resolve({ ok: true, json: async () => ({ doctor: '허진혁' }) });
  await first;
  assert.deepEqual(rendered, ['김상준']);
});

test('doctor route opens the desk layout and preserves doctor deep links', () => {
  const c = vm.createContext({ URL, URLSearchParams, window: { location: { search: '?view=doctor' } } });
  vm.runInContext(html.slice(html.indexOf('  const VIEW_TO_MODE ='), html.indexOf('  function getFixedBedNoFromUrl(')), c);
  assert.equal(c.getModeFromView(), 'input');
  const start = server.indexOf('const SHORT_LINKS =');
  vm.runInContext(server.slice(start, server.indexOf('// 대기실 사이니지', start)) + '\nglobalThis.links = SHORT_LINKS;', c);
  assert.equal(c.links.get('/doctor'), '/?view=doctor');
  assert.equal(c.mergeShortLinkQuery(c.links.get('/doctor'), new URLSearchParams('doctor=a')), '/?view=doctor&doctor=a');
  assert.equal(c.links.get('/doctor1'), '/?view=bed&bed=101');
});

test('doctor page blocks all HTTP mutations while allowing reads', async () => {
  const calls = [];
  const c = vm.createContext({ URLSearchParams, window: {
    location: { search: '?view=doctor' }, fetch: async (...args) => { calls.push(args); return { ok: true }; },
  }, document: { getElementById: () => ({}) } });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], c);
  await c.window.fetch('/api/beds');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(c.window.fetch('/api/beds/update', { method }), /조회 전용/);
  }
  assert.equal(calls.length, 1);
});

test('doctor viewers never complete timers, assign patients, release holds or clear old beds', async () => {
  const c = vm.createContext({ window: { getAppView: () => 'doctor' } });
  load(c, html, ['finishBedStep', 'assignWaitingPatientsToBeds', 'processHoldBedReleases', 'clearBedsLeftFromPreviousDate', 'cleanupOldDischargedPatients', 'migrateDisabledBedsToWaiting']);
  await c.finishBedStep(1);
  assert.equal(await c.assignWaitingPatientsToBeds(true), 0);
  await c.processHoldBedReleases();
  await c.clearBedsLeftFromPreviousDate();
  await c.cleanupOldDischargedPatients('2026-10-31');
  assert.equal(await c.migrateDisabledBedsToWaiting({}), 0);
});

test('doctor drawer cannot open even when its toggle is invoked; desk drawer still opens', () => {
  const classes = new Set();
  const style = { display: '', removeProperty() {} };
  const column = { style: { ...style } }, detail = { style: { ...style } };
  const panel = { classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    querySelector: selector => selector === '.input-form-column' ? column : detail };
  const button = { dataset: {}, setAttribute() {} };
  let page = 'doctor';
  const c = vm.createContext({ getAppView: () => page,
    document: { getElementById: id => id === 'inputPanel' ? panel : id === 'inputFormToggle' ? button : null },
    window: { renderBedMonitors() {} } });
  load(c, html, ['setInputFormOpen']);
  c.setInputFormOpen(true);
  assert.equal(button.hidden, true);
  assert.equal(column.hidden, true);
  assert.equal(classes.has('input-form-open'), false);
  page = 'desk';
  c.setInputFormOpen(true);
  assert.equal(button.hidden, false);
  assert.equal(column.hidden, false);
  assert.equal(classes.has('input-form-open'), true);
});
