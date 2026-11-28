const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const parser = require('./appointment-import');
const { createStore } = require('./server/appointments');
process.env.CLINIC_KEY_HEX = crypto.randomBytes(32).toString('hex');
const { encrypt, decrypt } = require('./server/crypto-util');
const headers = ['진    료예약일자', '전송', '예약시각', '환자명', '담당의사', '경과', '예약내역', '전화번호', ' 휴대전화', '차트번호'];
const entry = (chartNo = '1', date = '2026-11-19', time = '09:20', doctorName = '허진혁') => ({ date, time, chartNo, name: `환자${chartNo}`, doctorName });
const workbook = rows => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: rows } });
const XLSX = { utils: { sheet_to_json: sheet => sheet } };
function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, store: createStore(db, { encrypt, decrypt }) };
}
function apply(store, entries, sourceFile = '예약.xls', clearDates) {
  return store.commit(store.preview({ entries, sourceFile, clearDates }).token);
}

test('동의보감 raw numeric dates and time fractions are read with whitespace headers', () => {
  const rows = [headers, [46345, -1, 0.3888888888888889, ' 환자1 ', '허진혁', '', '', '', '', 12881],
    [46345, -1, 0.75, '환자2', '김상준', '', '', '', '', '0012882']];
  const parsed = parser.parseWorkbook(XLSX, workbook(rows));
  assert.deepEqual(parsed.map(row => [row.date, row.time, row.chartNo]),
    [['2026-11-19', '09:20', '12881'], ['2026-11-19', '18:00', '12882']]);
  assert.equal(parser.timeValue('tt 18:00:00'), '18:00');
  assert.equal(parser.timeValue('오후 1:30:00'), '13:30');
  assert.equal(parser.timeValue('12:30 AM'), '00:30');
});

test('invalid headers, bad dates, missing identity, and invalid rows reject the whole file', () => {
  assert.throws(() => parser.parseWorkbook(XLSX, workbook([['환자명', '차트번호']])), /열을 찾지/);
  assert.throws(() => parser.parseWorkbook(XLSX, workbook([headers])), /예약 데이터가 없습니다/);
  const bad = [46345, -1, 0.5, '환자1', '허진혁', '', '', '', '', ''];
  assert.throws(() => parser.parseWorkbook(XLSX, workbook([headers, bad])), /2행/);
  assert.throws(() => parser.validate([entry(), { ...entry('2'), date: '2026-02-30' }]), /2번째 예약/);
  assert.throws(() => parser.validate([{ ...entry(), time: '25:00' }]), /시각/);
  assert.throws(() => parser.validate([entry()], ['20261119']), /동시에/);
});

test('duplicate export rows and multiple same-day slots count one person and sort by time', () => {
  const groups = parser.validate([entry('1', undefined, '13:00'), entry('2'), entry('1'), entry('1')]);
  assert.equal(groups[0].entries.length, 3);
  const patients = parser.patientsOf(groups[0].entries);
  assert.equal(patients.length, 2);
  assert.deepEqual(patients[0].appointmentSlots.map(slot => slot.time), ['09:20', '13:00']);
});

test('replacement updates phone bookings, cancellations and times, preserves other dates, and encrypts records', t => {
  const { db, store } = setup(t);
  apply(store, [entry('1'), entry('2'), entry('3', '2026-11-20')]);
  const preview = store.preview({ entries: [entry('1', undefined, '10:00'), entry('4')], sourceFile: '최신.xls' });
  assert.deepEqual(preview.dates, [{ date: '2026-11-19', previousCount: 2, count: 2, added: 1, removed: 1, changed: 1 }]);
  store.commit(preview.token);
  assert.deepEqual(store.read('2026-11-19').entries.map(row => row.chartNo), ['1', '4']);
  assert.equal(store.read('2026-11-20').entries.length, 1);
  assert.equal(store.read('2026-11-19').source_file, '최신.xls');
  const encrypted = db.prepare('SELECT data_json FROM appointment_snapshots LIMIT 1').get().data_json;
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.ok(!encrypted.includes('환자1'));
  const history = db.prepare('SELECT previous_json FROM appointment_import_log ORDER BY id DESC LIMIT 1').get().previous_json;
  assert.ok(history.startsWith('enc:v1:'));
  assert.equal(JSON.parse(decrypt(history))[0].entries.length, 2);
});

test('preview is read-only, malformed imports do not replace any dates, and clearing requires an explicit date', t => {
  const { store } = setup(t);
  apply(store, [entry()]);
  store.preview({ entries: [entry('2')] });
  assert.equal(store.read('2026-11-19').entries[0].chartNo, '1');
  assert.throws(() => store.preview({ entries: [entry('2'), { ...entry('3'), name: '' }] }));
  assert.equal(store.read('2026-11-19').entries[0].chartNo, '1');
  assert.throws(() => store.preview({ entries: [] }));
  apply(store, [], '예약 없음', ['2026-11-19']);
  assert.deepEqual(store.read('2026-11-19').entries, []);
  assert.equal(store.list('2026-11-19', '2026-11-19').length, 1);
});

test('another desk cannot commit an outdated multi-date preview and tokens cannot be replayed', t => {
  const { store } = setup(t);
  const earlier = store.preview({ entries: [entry('1'), entry('2', '2026-11-20')] });
  const later = store.preview({ entries: [entry('3')] });
  store.commit(later.token);
  assert.throws(() => store.commit(earlier.token), /다른 데스크/);
  assert.equal(store.read('2026-11-20'), null);
  assert.equal(store.read('2026-11-19').entries[0].chartNo, '3');
  assert.throws(() => store.commit(later.token), /만료/);
});

function listingContext(store, patients, realtime = {}) {
  const source = fs.readFileSync(`${__dirname}/server/server.js`, 'utf8');
  const c = vm.createContext({
    appointmentStore: store, appointmentImport: parser, listPatients: () => patients,
    getStateValue: () => realtime, normalizeChartNo: value => String(value || '').replace(/^0+(?=\d)/, ''),
    normalizeSearchText: value => String(value || '').trim(), normalizePatientName: parser.text,
    ymd: date => date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }),
    visitDatesOf: patient => Object.keys(patient.visitHistory || {}), getPatientPhone: () => '', patientSort: () => 0,
  });
  vm.runInContext(source.slice(source.indexOf('function listUpcomingAppointments('), source.indexOf('function countPatients(')), c);
  return c;
}

test('existing calendar counts imported bookings, attends by identity, retains unmatched rows, and keeps old historical totals', t => {
  const { store } = setup(t);
  apply(store, [entry('1'), entry('2'), entry('3')]);
  const patients = [
    { patientId: 'p1', ...entry('1'), appointmentDates: ['2026-11-01', '2026-11-19'], visitHistory: { '2026-11-19': { timestamp: 1 } } },
    { patientId: 'old', ...entry('99'), appointmentDates: ['2026-11-19'] },
  ];
  const c = listingContext(store, patients, { p2: { ...entry('2'), timestamp: Date.parse('2026-11-19T09:00:00+09:00') } });
  const groups = c.listUpcomingAppointments('2026-11-01', '2026-11-30');
  const today = groups.find(group => group.date === '2026-11-19');
  assert.equal(today.count, 3);
  assert.equal(today.visitedCount, 2);
  assert.equal(today.patients[2].matchStatus, 'unmatched');
  assert.equal(today.source, 'donguibogam');
  assert.ok(today.importedAt);
  assert.equal(groups.find(group => group.date === '2026-11-01').count, 1);
  assert.ok(!today.patients.some(patient => patient.chartNo === '99'));
  apply(store, [], '예약 없음', ['2026-11-19']);
  assert.equal(c.listUpcomingAppointments('2026-11-19', '2026-11-19')[0].count, 0);
});

test('reused chart numbers with different names do not mark the wrong booking as attended', t => {
  const { store } = setup(t);
  apply(store, [entry('1')]);
  const c = listingContext(store, [{ ...entry('1'), name: '다른 환자', visitHistory: { '2026-11-19': {} } }],
    { other: { ...entry('1'), name: '다른 환자', timestamp: Date.parse('2026-11-19T09:00:00+09:00') } });
  assert.equal(c.listUpcomingAppointments('2026-11-19', '2026-11-19')[0].visitedCount, 0);
});

test('unimported dates retain existing bookings; a snapshot overrides only its date, including zero patients', t => {
  const { store } = setup(t);
  const c = listingContext(store, [
    { ...entry('1'), appointmentDates: ['2026-11-19', '2026-11-20'], visitHistory: {} },
    { ...entry('2'), appointmentHistory: [{ confirmedDate: '2026-11-19', result: 'confirmed' }], visitHistory: {} }
  ]);
  const counts = () => Array.from(c.listUpcomingAppointments('2026-11-19', '2026-11-20'), group => [group.date, group.count, group.source]);
  assert.deepEqual(counts(), [['2026-11-19', 2, 'legacy'], ['2026-11-20', 1, 'legacy']]);
  apply(store, [entry('3')]);
  assert.deepEqual(counts(), [['2026-11-19', 1, 'donguibogam'], ['2026-11-20', 1, 'legacy']]);
  apply(store, [], '예약 없음', ['2026-11-19']);
  assert.deepEqual(counts(), [['2026-11-19', 0, 'donguibogam'], ['2026-11-20', 1, 'legacy']]);
});

test('today R badge follows both legacy and imported rosters and never a bed request alone', () => {
  const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
  const c = vm.createContext({ normalizeChartNo: value => String(value).replace(/^0+(?=\d)/, ''),
    getTodayKey: () => '2026-11-19', upcomingAppointmentGroups: [] });
  vm.runInContext(html.slice(html.indexOf('  function isTodayAppointmentPatient('), html.indexOf('  function renderTodayAppointmentBadge(')), c);
  const patient = { chartNo: '001', name: '환자1', appointmentDates: ['2026-11-19'] };
  assert.equal(c.isTodayAppointmentPatient(patient), false);
  for (const source of ['legacy', 'donguibogam']) {
    c.upcomingAppointmentGroups = [{ date: '2026-11-19', source, patients: [entry('1')] }];
    assert.equal(c.isTodayAppointmentPatient(patient), true);
  }
  c.upcomingAppointmentGroups = [{ date: '2026-11-19', source: 'donguibogam', patients: [] }];
  assert.equal(c.isTodayAppointmentPatient(patient), false);
});


test('예약내역 travels through Excel parsing, encrypted snapshots and slots; changed or blank notes replace old notes',t=>{
 const {store}=setup(t);
 const parsed=parser.parseWorkbook(XLSX,workbook([headers,['2026-11-19','','09:20','환자1','허진혁','','장시간 치료','','','1']]));
 assert.equal(parsed[0].note,'장시간 치료');
 apply(store,parsed);
 assert.equal(parser.patientsOf(store.read('2026-11-19').entries)[0].appointmentSlots[0].note,'장시간 치료');
 const changed=[{...parsed[0],note:'<script>예약 내용</script>'}];
 assert.equal(parser.compare(parsed,changed).changed,1);
 apply(store,changed);assert.equal(store.read('2026-11-19').entries[0].note,changed[0].note);
 apply(store,[{...parsed[0],note:''}]);assert.equal(store.read('2026-11-19').entries[0].note,undefined);
 assert.equal(parser.patientsOf(store.read('2026-11-19').entries)[0].appointmentSlots[0].note,undefined);
});
