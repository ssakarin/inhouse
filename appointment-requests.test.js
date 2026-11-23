const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/index.html`, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  for (const match of rest.matchAll(/^  }\r?$/gm)) {
    const code = rest.slice(0, match.index + match[0].length);
    try { new vm.Script(code); return code; } catch {}
  }
  throw Error(name);
}

function setup() {
  const writes = [], toasts = [];
  const c = vm.createContext({
    window: { currentMode: 'input' },
    appointmentDeskAlertItems: new Map(), patientsByKey: new Map(),
    matchesDoctorPageRecord: () => true, isDoctorReadOnlyPage: () => false,
    renderUpcomingAlerts: () => {}, showToast: message => toasts.push(message),
    console: { error: () => {} },
    saveAppointmentDeskAlert: async (key, patch) => writes.push({ key, patch }),
  });
  for (const name of ['normalizeAppointmentDates', 'getAppointmentAlertDismissField',
    'shouldShowAppointmentAlertForMode', 'shouldShowUndecidedAlertForMode',
    'getAppointmentRequestVersion', 'getVisibleAppointmentAlertItems']) {
    vm.runInContext(extractFunction(name), c);
  }
  vm.runInContext(source.slice(source.indexOf('  window.acknowledgeAppointmentRequest ='),
    source.indexOf('  function getVisibleCallAlertItems(')), c);
  const add = (key, dates, timestamp = 100) => c.appointmentDeskAlertItems.set(key,
    { patientKey: key, name: key, chartNo: '123', dates, timestamp });
  const click = key => {
    const item = c.getVisibleAppointmentAlertItems().find(item => item.patientKey === key);
    return c.window.acknowledgeAppointmentRequest(key, c.getAppointmentRequestVersion(item));
  };
  return { c, writes, toasts, add, click };
}

test('click retains the request below active patients, persists across desks, and never writes reservations', async () => {
  const r = setup();
  r.add('first', ['2026-11-19']);
  r.add('later', ['2026-11-25'], 200);
  await r.click('first');
  const items = r.c.getVisibleAppointmentAlertItems();
  assert.deepEqual(Array.from(items, item => [item.patientKey, item.acknowledged]),
    [['later', false], ['first', true]]);
  assert.equal(r.writes.length, 1);
  assert.deepEqual(Object.keys(r.writes[0].patch).sort(), ['acknowledgedAt', 'acknowledgedVersion']);
  const otherDesk = setup();
  otherDesk.c.appointmentDeskAlertItems.set('first', JSON.parse(JSON.stringify(r.c.appointmentDeskAlertItems.get('first'))));
  assert.equal(otherDesk.c.getVisibleAppointmentAlertItems()[0].acknowledged, true);
  await r.click('first');
  assert.equal(r.writes.length, 1);
});

test('changed dates, undecided choice, and a new request of the same date reactivate the card', async () => {
  for (const change of [{ dates: ['2026-11-20'] }, { undecided: true }, { timestamp: 200 }]) {
    const r = setup();
    r.add('patient', ['2026-11-19']);
    await r.click('patient');
    Object.assign(r.c.appointmentDeskAlertItems.get('patient'), change);
    assert.equal(r.c.getVisibleAppointmentAlertItems()[0].acknowledged, false);
  }
});

test('an old click cannot acknowledge changed dates, including during a pending save', async () => {
  const r = setup();
  r.add('patient', ['2026-11-19']);
  const version = r.c.getAppointmentRequestVersion(r.c.appointmentDeskAlertItems.get('patient'));
  r.c.appointmentDeskAlertItems.get('patient').dates = ['2026-11-20'];
  await r.c.window.acknowledgeAppointmentRequest('patient', version);
  assert.equal(r.writes.length, 0);
  let release;
  r.c.saveAppointmentDeskAlert = () => new Promise(resolve => { release = resolve; });
  const pending = r.click('patient');
  r.c.appointmentDeskAlertItems.get('patient').dates = ['2026-11-21'];
  release();
  await pending;
  assert.equal(r.c.getVisibleAppointmentAlertItems()[0].acknowledged, false);
});

test('failed saves leave the card active and allow retry', async () => {
  const r = setup();
  r.add('patient', ['2026-11-19']);
  r.c.saveAppointmentDeskAlert = async () => { throw Error('offline'); };
  await r.click('patient');
  assert.equal(r.c.getVisibleAppointmentAlertItems()[0].acknowledged, false);
  assert.equal(r.toasts.length, 1);
});

test('legacy and undecided requests remain visible after acknowledgement without changing patient dates', async () => {
  const r = setup();
  const patient = { name: 'patient', chartNo: '123', appointmentDates: ['2026-11-19'],
    appointmentUndecided: true, timestamp: Date.now() };
  const before = JSON.stringify(patient);
  r.c.patientsByKey.set('patient', patient);
  await r.click('patient');
  assert.equal(r.c.getVisibleAppointmentAlertItems().length, 1);
  assert.equal(r.c.getVisibleAppointmentAlertItems()[0].acknowledged, true);
  assert.equal(r.c.getVisibleAppointmentAlertItems()[0].undecided, true);
  assert.equal(JSON.stringify(patient), before);
});

test('doctor read-only page cannot acknowledge requests', async () => {
  const r = setup();
  r.add('patient', ['2026-11-19']);
  r.c.isDoctorReadOnlyPage = () => true;
  await r.click('patient');
  assert.equal(r.writes.length, 0);
});

test('appointment calendar shows daily no-show rates, without labels and with future dates excluded', () => {
  const elements = { appointmentCalendarTitle: {}, appointmentCalendar: {} };
  const c = vm.createContext({
    appointmentCalendarMonth: '2026-11', appointmentSelectedDate: '2026-11-23',
    appointmentCalendarGroups: [
      { date: '2026-11-20', count: 3, visitedCount: 2 },
      { date: '2026-11-21', count: 2, visitedCount: 2 },
      { date: '2026-11-22', count: 0, visitedCount: 0 },
      { date: '2026-11-23', count: 4, visitedCount: 1 },
      { date: '2026-11-24', count: 5, visitedCount: 0 }
    ],
    getTodayKey: () => '2026-11-23',
    toLocalDateInputValue: d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
    document: { getElementById: id => elements[id] }
  });
  for (const name of ['getAppointmentNoShowSummary', 'renderAppointmentCalendar']) {
    vm.runInContext(extractFunction(name), c);
  }
  c.renderAppointmentCalendar();
  const html = elements.appointmentCalendar.innerHTML;
  const day = date => html.match(new RegExp(`onclick="selectAppointmentDate\\('2026-11-${date}'\\)">([\\s\\S]*?)</button>`))[1];
  assert.match(day('20'), />33\.3%<\/span>/);
  assert.match(day('20'), /미내원 1명 \/ 예약 3명/);
  assert.match(day('21'), />0%<\/span>/);
  assert.doesNotMatch(day('22'), /부도율/);
  assert.match(day('23'), />75%<\/span>/);
  assert.match(day('24'), /5명/);
  assert.doesNotMatch(day('24'), /부도율/);
  assert.doesNotMatch(html, /부도율/);
  assert.equal(c.getAppointmentNoShowSummary(undefined), null);
});
