'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const sync = require('./bogam-sync');
const { createStore } = require('./appointments');
const { sourceResult, createHandler } = require('../bogam-bridge/bridge');
const { buildQuery, accountSql } = require('../bogam-bridge/queries');
const { createTransport, loadConfig } = require('./bogam-transport');
const { EventEmitter } = require('node:events');
const period = { start: '2026-11-01', end: '2026-11-30' };
const request = { visits: period, bookings: period };
const visit = { chartNo: '000123', name: '가상환자', date: '20261128', diagnosisId: 'd1', customerId: 'c1',
  receptionTime: '093001', diagnosisTime: '10:00:00', doctorName: '가상원장' };
const booking = { chartNo: '123', name: '가상환자', date: '2026-11-28', time: '14:00', doctorName: '가상원장' };
const payload = () => ({ ok: true, readOnlyVerified: true, elapsedMs: 10, visits: [visit], bookings: [booking] });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('range validation allows any weekday/hour but rejects invalid, reversed and excessive dates', () => {
  assert.deepEqual(sync.ranges(request), request);
  assert.throws(() => sync.range({ start: '2026-02-30', end: '2026-03-01' }));
  assert.throws(() => sync.range({ start: '2026-12-01', end: '2026-11-01' }));
  assert.throws(() => sync.range({ start: '2024-01-01', end: '2026-11-01' }));
});
test('normalization reuses appointment validation and deduplicates exact source visits', () => {
  const data = sync.normalize({ visits: [visit, visit], bookings: [booking, booking] }, request);
  assert.equal(data.visits.length, 1); assert.equal(data.visits[0].chartNo, '123');
  assert.equal(data.visits[0].receptionTime, '09:30:01'); assert.equal(data.groups[0].entries.length, 1);
  assert.throws(() => sync.normalize({ visits: [visit, { ...visit, receptionTime: '11:00' }], bookings: [] }, request), /AMBIGUOUS/);
  assert.throws(() => sync.normalize({ visits: [{ ...visit, date: '20261201' }], bookings: [] }, request));
  assert.throws(() => sync.normalize({ visits: [{ ...visit, receptionTime: '' }], bookings: [] }, request));
});
test('visit merge preserves clinical notes, treatments, revenue, earlier history and identity; is repeatable', () => {
  const existing = { patientId: 'saved-id', chartNo: '123', name: '가상환자', memo: '보드 메모', treatments: ['침'], packages: { n: 5 },
    visitDates: ['2026-10-01'], visitHistory: { '2026-10-01': { memo2: '이전 메모' }, '2026-11-28': { memo2: '오늘 메모', totalFee: 100, treatments: ['추나'] } } };
  const before = structuredClone(existing);
  const data = sync.normalize(payload(), request);
  const [record] = sync.planPatients(data.visits, () => [existing]);
  assert.deepEqual(existing, before); assert.equal(record.patientId, existing.patientId);
  assert.equal(record.visitHistory['2026-11-28'].memo2, '오늘 메모');
  assert.equal(record.visitHistory['2026-11-28'].totalFee, 100);
  assert.deepEqual(record.treatments, ['침']); assert.deepEqual(record.packages, { n: 5 });
  assert.equal(record.visitHistory['2026-11-28'].timestamp, Date.parse('2026-11-28T09:30:01+09:00'));
  assert.deepEqual(sync.planPatients(data.visits, () => [record]), [record]);
  assert.deepEqual(sync.planPatients(data.visits, () => [{ name: '다른 이름' }]), []);
  const corrected = sync.planPatients([{ ...data.visits[0], receptionTime: '10:30' }], () => [record])[0];
  assert.equal(corrected.visitHistory['2026-11-28'].timestamp, Date.parse('2026-11-28T10:30:00+09:00'));
});

test('Excel-style conflict preflight skips conflicting charts only, preserves existing records and counts exclusions',()=>{
  const existing={chartNo:'123',name:'기존 이름',memo2:'보존 메모'};
  const before=structuredClone(existing);
  const input=sync.normalize({visits:[visit,{...visit,chartNo:'456',name:'정상 환자',diagnosisId:'safe',customerId:'safe'}],bookings:[]},request);
  const stats={};
  const records=sync.planPatients(input.visits,chart=>chart==='123'?[existing]:[],stats);
  assert.deepEqual(records.map(p=>p.chartNo),['456']);assert.deepEqual(existing,before);
  assert.deepEqual(stats,{skippedPatients:1,skippedVisits:1});
  const split=sync.normalize({visits:[visit,{...visit,name:'두 번째 이름',diagnosisId:'other'},
    {...visit,chartNo:'456',name:'정상 환자',diagnosisId:'safe',customerId:'safe'}],bookings:[]},request);
  const splitStats={};const allowed=sync.planPatients(split.visits,()=>[],splitStats);
  assert.deepEqual(allowed.map(p=>p.chartNo),['456']);assert.deepEqual(splitStats,{skippedPatients:2,skippedVisits:2});
  assert.equal(sync.planPatients(input.visits.slice(0,1),()=>[{name:visit.name},{name:'또 다른 기존 이름'}]).length,1);
});
test('coordinator reports successful rows and conflict exclusions without exposing patient identifiers',async()=>{
  const source={...payload(),visits:[visit,{...visit,chartNo:'456',name:'정상 환자',diagnosisId:'safe',customerId:'safe'}]};
  const c=sync.createCoordinator({enabled:true,applyEnabled:true,publish:()=>{},fetchSource:async()=>source,
    apply:data=>{const stats={};const rows=sync.planPatients(data.visits,chart=>chart==='123'?[{name:'다른 기존 이름'}]:[],stats);
      return {appliedAt:'success',patients:rows.length,...stats};}});
  const result=await c.run(request);
  assert.equal(result.patients,1);assert.equal(result.counts.visits,1);assert.equal(result.counts.skippedPatients,1);
  assert.equal(c.status().phase,'completed');assert.equal(c.status().counts.skippedVisits,1);
  assert.ok(!JSON.stringify(c.status()).includes('정상 환자'));
});
test('multiple consultations retain distinct diagnosis records without creating a combined daily record', () => {
  const data = sync.normalize({ visits: [{ ...visit, diagnosisId: 'd2', receptionTime: '12:00' }, visit], bookings: [] }, request);
  const records = sync.planPatients(data.visits, () => []);
  assert.equal(records.length, 1); assert.equal(records[0].visitDates.length, 1);
  assert.equal(records[0].visitHistory['2026-11-28'],undefined);
  assert.equal(Object.keys(records[0].bogamVisitRecords).length,2);
  assert.deepEqual(records[0].bogamMultipleVisitDates,['2026-11-28']);
});

test('coordinator runs no query on init/status; simultaneous requests share one query and one apply', async () => {
  const gate = deferred(); let queries = 0, applies = 0;
  const c = sync.createCoordinator({ enabled: true, applyEnabled: true, publish: () => {},
    fetchSource: () => { queries++; return gate.promise; }, apply: () => { applies++; return { appliedAt: 'success' }; } });
  c.status(); assert.equal(queries, 0);
  const first = c.run(request), second = c.run(request);
  assert.equal(first, second);
  await assert.rejects(c.run({ ...request, visits: { ...period, end: '2026-11-29' } }), /SYNC_BUSY/);
  gate.resolve(payload()); await first;
  assert.equal(queries, 1); assert.equal(applies, 1); assert.equal(c.status().lastAppliedAt, 'success');
});
test('dry run never writes, failure preserves last success, and lock is released for retry', async () => {
  let writes = 0, rejectSource = false;
  const c = sync.createCoordinator({ enabled: true, applyEnabled: false, initialStatus: { lastAppliedAt: 'prior' }, publish: () => {},
    fetchSource: async () => { if (rejectSource) throw sync.failure('SYNC_TIMEOUT', 504); return { ok: true, dryRun: true,
      counts: { visits: 1, bookings: 2, unmappedDoctors: 1 }, elapsedMs: 12 }; }, apply: () => { writes++; } });
  await c.run(request); assert.equal(writes, 0); assert.equal(c.status().phase, 'validated');
  rejectSource = true; await assert.rejects(c.run(request), /SYNC_TIMEOUT/);
  assert.equal(c.status().lastAppliedAt, 'prior'); assert.equal(c.status().running, false);
  rejectSource = false; await c.run(request); assert.equal(c.status().phase, 'validated');
});
test('apply requires read-only attestation and validated complete response', async () => {
  let writes = 0;
  for (const response of [{ ...payload(), readOnlyVerified: false }, { ...payload(), bookings: null }]) {
    const c = sync.createCoordinator({ enabled: true, applyEnabled: true, publish: () => {}, fetchSource: async () => response, apply: () => writes++ });
    await assert.rejects(c.run(request));
  }
  assert.equal(writes, 0);
});

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE fake_patients(chart TEXT PRIMARY KEY, data TEXT); CREATE TABLE fake_state(key TEXT PRIMARY KEY, data TEXT)');
  const store = createStore(db, { encrypt: x => x, decrypt: x => x });
  const initial = store.preview({ entries: [booking, { ...booking, chartNo: '456', name: '다른가상환자', time: '15:00' }] }); store.commit(initial.token);
  return { db, store };
}
test('DB booking replacement matches Excel, removes omitted slots only on present dates, and preserves absent dates', () => {
  const {db,store}=database();
  store.commit(store.preview({entries:[{...booking,date:'2026-11-29'}]}).token);
  const groups=sync.normalize(payload(),request).groups;
  for(let n=0;n<2;n++){db.exec('BEGIN');store.replaceFromBogam(groups,'now');db.exec('COMMIT');}
  assert.equal(store.read('2026-11-28').entries.length,1);
  assert.equal(store.read('2026-11-29').entries.length,1);
  const changed=sync.normalize({visits:[],bookings:[{...booking,time:'16:00'}]},request).groups;
  db.exec('BEGIN');store.replaceFromBogam(changed,'now');db.exec('COMMIT');
  assert.deepEqual(store.read('2026-11-28').entries.map(x=>x.time),['16:00']);
  store.replaceFromBogam([],'now');assert.equal(store.read('2026-11-28').entries.length,1);
  const manual=createStore(new DatabaseSync(':memory:'),{encrypt:x=>x,decrypt:x=>x});
  manual.commit(manual.preview({entries:changed.flatMap(g=>g.entries)}).token);
  assert.deepEqual(store.read('2026-11-28').entries,manual.read('2026-11-28').entries);
  db.close();
});

test('production apply transaction rolls back patients, bookings and last success together on local write failure', async () => {
  const {db, store} = database(); let failWrite = true, invalidations = 0;
  const source = fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  const start = source.indexOf('let bogamCoordinator;'), end = source.indexOf('\ndb.exec(`CREATE TABLE IF NOT EXISTS daily_clinic_metrics',start);
  const setStateValue = (key,value) => db.prepare('INSERT OR REPLACE INTO fake_state VALUES(?,?)').run(key, JSON.stringify(value));
  const getStateValue = key => { const row=db.prepare('SELECT data FROM fake_state WHERE key=?').get(key); return row ? JSON.parse(row.data) : null; };
  setStateValue('bogamSyncStatus',{lastAppliedAt:'prior'});
  const c = vm.createContext({ bogamSync: sync, bogamTransport: { loadConfig: () => ({ enabled:true,applyEnabled:true }), createTransport: () => async () => payload() },
    process: {env:{}}, getStateValue, setStateValue, sseBroadcastState:()=>{}, stateValueCache:new Map(), db,
    getPatientsByChartNo: chart => { const row=db.prepare('SELECT data FROM fake_patients WHERE chart=?').get(chart);return row ? [JSON.parse(row.data)] : []; },
    mergePatientImportRecord:x=>x, savePatient: x => db.prepare('INSERT OR REPLACE INTO fake_patients VALUES(?,?)').run(x.chartNo,JSON.stringify(x)),
    appointmentStore:{read:store.read,replaceFromBogam:(...args)=>{store.replaceFromBogam(...args);if(failWrite)throw Error('simulated disk failure');}},
    listUpcomingAppointments:()=>[],
    crypto:require('node:crypto'),invalidatePatientCache:()=>invalidations++ });
  const coordinator=vm.runInContext(`${source.slice(start,end)}\ngetBogamCoordinator()`,c);
  await assert.rejects(coordinator.run(request));
  assert.equal(db.prepare('SELECT count(*) AS n FROM fake_patients').get().n,0);
  assert.equal(store.read('2026-11-28').entries.length,2);
  assert.equal(store.read('2026-11-28').revision,1);
  assert.equal(getStateValue('bogamSyncStatus').lastAppliedAt,'prior');assert.equal(invalidations,1);
  failWrite=false;await coordinator.run(request);await coordinator.run(request);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fake_patients').get().n,1);
  assert.equal(store.read('2026-11-28').entries.length,1);
  assert.notEqual(getStateValue('bogamSyncStatus').lastAppliedAt,'prior');db.close();
});


const extendedVisit = (patch = {}) => ({ ...visit, ageAtVisit: 45, sex: '여 ', mobile: '01000000000',
  insuranceCode: '2', insuranceDetailCode: 'raw-detail-01', visitModeCode: '11',
  primaryDiagnosisRows: 1, diagnosisCode: 'M000', accountRows: 1,
  totalFee: 15000, claimAmount: 10000, insuredCopay: 3000, nonCoveredAmount: 2000, ...patch });
function mergeExtended(row, existing = {}) {
  return sync.planPatients(sync.normalize({visits:[row],bookings:[]},request).visits,()=>[
    {chartNo:'123',name:visit.name,...existing}
  ])[0];
}
test('verified visit fields update and confirmed zero amounts replace old values without erasing notes or diagnosis names',()=>{
  const existing={insuranceType:'급여1종',memo2:'치료 메모',visitHistory:{'2026-11-28':{
    totalFee:999,claimAmount:999,insuredCopay:999,nonCoveredAmount:999,chiefComplaint:'기존 상병명',memo2:'날짜별 메모',treatments:['침']
  }}};
  const record=mergeExtended(extendedVisit({totalFee:0,claimAmount:0,insuredCopay:0,nonCoveredAmount:0}),existing);
  const v=record.visitHistory['2026-11-28'];
  for(const key of ['totalFee','claimAmount','insuredCopay','nonCoveredAmount'])assert.equal(v[key],0);
  assert.equal(v.diagnosisCode,'M000');assert.equal(v.chiefComplaint,'기존 상병명');assert.equal(v.memo2,'날짜별 메모');
  assert.deepEqual(v.treatments,['침']);assert.equal(record.memo2,'치료 메모');
  assert.equal(record.age,45);assert.equal(record.gender,'여');assert.equal(record.phone,'01000000000');
  assert.equal(record.insuranceType,'급여1종');assert.equal(v.bogamInsuranceCategory,'의료급여');
  assert.equal(v.bogamInsuranceDetailCode,'raw-detail-01');assert.equal(v.visitType,'초진');
});
test('missing or ambiguous Account preserves total, independent DigBill updates, and SQL null never becomes zero',()=>{
  const old={totalFee:100,claimAmount:200,insuredCopay:300,nonCoveredAmount:400,diagnosisCode:'OLD'};
  for(const n of [0,2]){
    const r=mergeExtended(extendedVisit({accountRows:n,primaryDiagnosisRows:n}),{visitHistory:{'2026-11-28':old}});
    assert.equal(r.visitHistory['2026-11-28'].totalFee,old.totalFee);
    assert.equal(r.visitHistory['2026-11-28'].diagnosisCode,old.diagnosisCode);
    assert.equal(r.visitHistory['2026-11-28'].claimAmount,10000);
  }
  const r=mergeExtended(extendedVisit({totalFee:null,claimAmount:null,insuredCopay:null,nonCoveredAmount:null,diagnosisCode:null}),{visitHistory:{'2026-11-28':old}});
  for(const [key,value] of Object.entries(old))assert.equal(r.visitHistory['2026-11-28'][key],value);
  assert.throws(()=>mergeExtended(extendedVisit({totalFee:'not-a-number'})),/INVALID_SOURCE/);
});
test('unverified codes retain existing labels and raw codes; mode 42 retains the verified auto revisit label',()=>{
  const r=mergeExtended(extendedVisit({insuranceCode:'99',insuranceDetailCode:'0007',visitModeCode:'99',sex:'미확인',mobile:''}),
    {visitType:'초진',insuranceType:'자보 보험사',gender:'남',phone:'기존연락처',visitHistory:{'2026-11-28':{visitType:'재진'}}});
  assert.equal(r.insuranceType,'자보 보험사');assert.equal(r.gender,'남');assert.equal(r.phone,'기존연락처');
  assert.equal(r.visitType,'초진');assert.equal(r.visitHistory['2026-11-28'].visitType,'재진');
  assert.equal(r.bogamVisitModeCode,'99');assert.equal(r.bogamInsuranceDetailCode,'0007');
  const known=mergeExtended(extendedVisit({visitModeCode:'42',insuranceCode:'4'}));
  assert.equal(known.visitType,'자보(재)');assert.equal(known.bogamVisitModeCode,'42');assert.equal(known.bogamInsuranceCategory,'자동차');assert.equal(known.insuranceType,undefined);
});

test('insurance detail labels use only verified pairs and the confirmed NoneInsu prefix exception',()=>{
  for(const [insuranceCode,insuranceDetailCode,label] of [['1','0','건강보험'],['1','3','차상2종'],['2','1','급여1종'],['2','2','급여2종']]) {
    const r=mergeExtended(extendedVisit({insuranceCode,insuranceDetailCode,noneInsurance:0}),{insuranceType:'旧表示'});
    assert.equal(r.insuranceType,label);assert.equal(r.visitHistory['2026-11-28'].insuranceType,label);
    assert.equal(r.bogamInsuranceDetailCode,insuranceDetailCode);
  }
  assert.equal(mergeExtended(extendedVisit({insuranceCode:'1',insuranceDetailCode:'0',noneInsurance:1})).insuranceType,'비*건강보험');
  for(const patch of [
    {insuranceCode:'1',insuranceDetailCode:'3',noneInsurance:1},
    {insuranceCode:'2',insuranceDetailCode:'1',noneInsurance:1},
    {insuranceCode:'1',insuranceDetailCode:'99',noneInsurance:0},
    {insuranceCode:'1',insuranceDetailCode:'0',noneInsurance:null}
  ])assert.equal(mergeExtended(extendedVisit(patch),{insuranceType:'기존 상세명'}).insuranceType,'기존 상세명');
});
test('auto insurer labels require a verified detail code and unambiguous equal Name/Caption; never guess precedence',()=>{
  const base={insuranceCode:'4',insuranceDetailCode:'17',noneInsurance:0,insurerNameVariants:1,insurerCaptionVariants:1,insurerName:'보험사A ',insurerCaption:'보험사A '};
  for(const code of ['17','18','19'])assert.equal(mergeExtended(extendedVisit({...base,insuranceDetailCode:code})).insuranceType,'자보:보험사A');
  for(const patch of [{insurerCaption:'보험사B'},{insurerCaption:null},{insurerNameVariants:2},{insurerNameVariants:0},{insuranceDetailCode:'20'},{noneInsurance:1},
    {insurerName:'보험  사A',insurerCaption:'보험 사A'}]) {
    assert.equal(mergeExtended(extendedVisit({...base,...patch}),{insuranceType:'기존 보험사'}).insuranceType,'기존 보험사');
  }
});
test('DiagMode is authoritative, includes 無診, and deprecated DiagType input cannot change visit classification',()=>{
  assert.equal(mergeExtended(extendedVisit({visitModeCode:'14'})).visitType,'無診');
  const row=extendedVisit({visitModeCode:undefined,visitTypeCode:'11'});
  const r=mergeExtended(row,{visitType:'재진',visitHistory:{'2026-11-28':{visitType:'재진'}}});
  assert.equal(r.visitType,'재진');assert.equal(r.bogamVisitModeCode,undefined);
  assert.equal(mergeExtended(extendedVisit({visitModeCode:'99'}),{visitType:'재진'}).visitType,'재진');
  const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  const start=source.indexOf('function normalizeVisitType('),end=source.indexOf('\nfunction getVisitRecord(',start);
  const normalize=vm.runInNewContext(`(${source.slice(start,end)})`);
  assert.equal(normalize('자보(재)'),'재진');assert.equal(normalize('無診'),'');assert.equal(normalize('미확인'),'');
});
test('same-day diagnosis IDs retain separate financial records across retries, partial fetches and missing Account',()=>{
  const normalizeRows=rows=>sync.normalize({visits:rows,bookings:[]},request).visits;
  const a=extendedVisit({diagnosisId:'A',totalFee:100}),b=extendedVisit({diagnosisId:'B',totalFee:200,receptionTime:'13:00'});
  let records=sync.planPatients(normalizeRows([a,b]),()=>[]);
  let r=records[0];assert.equal(r.visitHistory['2026-11-28'],undefined);
  const key=id=>JSON.stringify([id,'c1','2026-11-28']);
  assert.equal(r.bogamVisitRecords[key('A')].totalFee,100);assert.equal(r.bogamVisitRecords[key('B')].totalFee,200);
  assert.equal(r.bogamVisitRecords[key('A')].diagnosisId,'A');
  r=sync.planPatients(normalizeRows([a,b]),()=>[r])[0];assert.equal(Object.keys(r.bogamVisitRecords).length,2);
  r=sync.planPatients(normalizeRows([{...a,accountRows:0,totalFee:0,claimAmount:0}]),()=>[r])[0];
  assert.equal(r.bogamVisitRecords[key('A')].totalFee,100);assert.equal(r.bogamVisitRecords[key('A')].claimAmount,0);
  assert.equal(r.bogamVisitRecords[key('B')].totalFee,200);assert.equal(r.visitHistory['2026-11-28'],undefined);
  r=sync.planPatients(normalizeRows([{...a,accountRows:1,totalFee:0}]),()=>[r])[0];assert.equal(r.bogamVisitRecords[key('A')].totalFee,0);
});
test('historical visit age does not overwrite later age and multiple same-day visits do not invent billing sums',()=>{
  const old={chartNo:'123',name:visit.name,age:50,doctorName:'현재원장',visitDates:['2026-12-01'],visitHistory:{'2026-11-28':{totalFee:777}}};
  const r=mergeExtended(extendedVisit(),old);assert.equal(r.age,50);assert.equal(r.doctorName,'현재원장');
  assert.equal(r.visitHistory['2026-11-28'].ageAtVisit,45);
  const visits=sync.normalize({visits:[extendedVisit(),extendedVisit({diagnosisId:'other',receptionTime:'11:00'})],bookings:[]},request).visits;
  assert.equal(sync.planPatients(visits,()=>[old])[0].visitHistory['2026-11-28'].totalFee,777);
});

test('one effective distinct diagnosis name updates visit and latest master without changing treatment notes',()=>{
  const old={chiefComplaint:'기존 상병명',memo2:'환자 메모',visitHistory:{'2026-11-28':{chiefComplaint:'기존 방문 상병명',memo2:'치료 메모',treatments:['침']}}};
  // SQL COUNT(DISTINCT ...) returns 1 for multiple rows with the same name.
  const row=extendedVisit({diagnosisNameVariants:1,diagnosisName:'확인된 주상병명'});
  const r=mergeExtended(row,old);
  assert.equal(r.chiefComplaint,'확인된 주상병명');assert.equal(r.visitHistory['2026-11-28'].chiefComplaint,'확인된 주상병명');
  assert.equal(r.memo2,'환자 메모');assert.equal(r.visitHistory['2026-11-28'].memo2,'치료 메모');
  assert.deepEqual(r.visitHistory['2026-11-28'].treatments,['침']);
  assert.deepEqual(mergeExtended(row,r),r);
});
test('missing or ambiguous effective diagnosis names and primary rows cannot clear or overwrite names',()=>{
  const old={chiefComplaint:'보존할 이름',visitHistory:{'2026-11-28':{chiefComplaint:'보존할 방문 이름'}}};
  for(const patch of [
    {diagnosisNameVariants:0,diagnosisName:null},
    {diagnosisNameVariants:2,diagnosisName:'임의 최대 이름'},
    {diagnosisNameVariants:1,diagnosisName:'   '},
    {diagnosisNameVariants:1,diagnosisName:null},
    {primaryDiagnosisRows:0,diagnosisNameVariants:1,diagnosisName:'적용 금지'},
    {primaryDiagnosisRows:2,diagnosisNameVariants:1,diagnosisName:'적용 금지'}
  ]){
    const r=mergeExtended(extendedVisit(patch),old);
    assert.equal(r.chiefComplaint,old.chiefComplaint);
    assert.equal(r.visitHistory['2026-11-28'].chiefComplaint,old.visitHistory['2026-11-28'].chiefComplaint);
  }
  const historic=mergeExtended(extendedVisit({diagnosisNameVariants:1,diagnosisName:'과거 상병명'}),
    {...old,visitDates:['2026-12-01']});
  assert.equal(historic.chiefComplaint,old.chiefComplaint);assert.equal(historic.visitHistory['2026-11-28'].chiefComplaint,'과거 상병명');
});

test('query uses confirmed source tables, native range predicates and parameters; has no write SQL or NOLOCK', () => {
  const q = buildQuery(request, {mappingVerified:true,dateStorage:'yyyymmdd'});
  assert.equal(q.parameters.vStart.value,'20261101'); assert.equal(q.parameters.vEnd.value,'20261201');
  for(const name of ['DigMast','DigAccept','DigBook','CustMast']) assert.ok(q.sql.includes(`dbo.${name}`));
  assert.doesNotMatch(q.sql,/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|EXEC|GRANT|DENY|REVOKE|SET|NOLOCK|TreatRoom|TreatRoomHist)\b/i);
  assert.ok(q.sql.includes('a.da_AccDate=m.dm_DiagDate'));assert.ok(q.sql.includes('b.dbk_DiagDate >= @bStart'));
  assert.throws(()=>buildQuery(request,{mappingVerified:false,dateStorage:'yyyymmdd'}),/SOURCE_NOT_CONFIGURED/);
  assert.equal(buildQuery(request,{mappingVerified:true,dateStorage:'date'}).parameters.vStart.type,'DateTime');
  assert.match(accountSql,/fn_my_permissions/);
  assert.match(q.sql,/h\.ms_Code=s\.DiagnosisCode AND h\.ms_No=s\.DiagnosisNo/);
  assert.match(q.sql,/COUNT\(DISTINCT[\s\S]*?h\.ms_Name/);
  assert.match(q.sql,/s\.RowCount=1 AND dn\.NameCount=1/);
  assert.match(q.sql,/h\.ms_DueDate[\s\S]*?<= TRY_CONVERT\(date, CONVERT\(nvarchar\(30\), m\.dm_DiagDate/);
  assert.match(q.sql,/h\.ms_ExpDate[\s\S]*?>= TRY_CONVERT\(date, CONVERT\(nvarchar\(30\), m\.dm_DiagDate/);
  assert.doesNotMatch(q.sql,/dbo\.MediHSick\b/);
  assert.match(q.sql,/m\.dm_DiagMode\) AS visitModeCode/);assert.doesNotMatch(q.sql,/dm_DiagType/);
  assert.match(q.sql,/i\.inc_Code=a\.da_InsuKind/);
  assert.doesNotMatch(q.sql,/dbk_Accept|dbk_BookID/);
});
test('bridge dry-run returns counts only; unmapped doctors and admin accounts cannot enable live apply', () => {
  const raw = [{...visit,doctorName:null}];
  const sets=[[{readOnlyVerified:false}],raw,[{...booking,doctorName:null}]];
  const result=sourceResult(sets,request,{doctorNames:{}},true,10);
  assert.equal(result.counts.unmappedDoctors,2);assert.equal(result.readOnlyVerified,false);
  assert.ok(!JSON.stringify(result).includes('가상환자'));assert.equal(result.visits,undefined);
  assert.throws(()=>sourceResult(sets,request,{doctorNames:{A:'가상원장'}},false,10),/READ_ONLY/);
  sets[0][0].readOnlyVerified=true;
  assert.throws(()=>sourceResult(sets,request,{doctorNames:{}},false,10),/UNMAPPED/);
  sets[1][0].doctorName='DB원장'; sets[2][0].doctorName='DB원장';
  assert.equal(sourceResult(sets,request,{},false,10).visits[0].doctorName,'DB원장');
});

test('bridge checks token and server IP; holds one query lock and defaults to counts-only mode', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bogam-test-')); const tokenFile=path.join(dir,'token');const token='a'.repeat(64);fs.writeFileSync(tokenFile,token);
  const gate=deferred();let queries=0;
  const config={tokenFile,allowedClientIp:'127.0.0.1',applyEnabled:false,mappingVerified:true,dateStorage:'yyyymmdd',doctorNames:{A:'가상원장'}};
  const server=http.createServer(createHandler(config,async()=>{queries++;return gate.promise;}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}/v1/query`;
  const options={method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({...request,dryRun:false})};
  assert.equal((await fetch(url,{...options,headers:{}})).status,403);assert.equal(queries,0);
  const first=fetch(url,options); await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal((await fetch(url,options)).status,409);assert.equal(queries,1);
  gate.resolve([[{readOnlyVerified:false}],[{...visit,doctorCode:'A'}],[{...booking,doctorName:null}]]);
  const result=await (await first).json();assert.equal(result.dryRun,true);assert.equal(result.visits,undefined);
});

test('transport enforces TLS, bounded whole-request timeout, safe network errors and truncated response failure', async t => {
  let options,req,res,onResponse;
  const requestStub=(_url,opts,callback)=>{
    options=opts;onResponse=callback;
    req=new EventEmitter();req.end=()=>{};req.destroy=()=>{};return req;
  };
  const transport=createTransport({url:new URL('https://127.0.0.1:8788/'),token:'a'.repeat(64),ca:'test-ca'},requestStub);
  const network=transport(request);req.emit('error',Error('secret error details'));
  await assert.rejects(network,error=>error.code==='DESK_UNREACHABLE'&&!error.message.includes('secret'));
  const truncated=transport(request);res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};
  onResponse(res);res.emit('aborted');await assert.rejects(truncated,/DESK_UNREACHABLE/);
  assert.equal(options.rejectUnauthorized,true);assert.equal(options.ca,'test-ca');
  t.mock.timers.enable({apis:['setTimeout']});
  const timeout=transport(request);const rejected=assert.rejects(timeout,/SYNC_TIMEOUT/);
  t.mock.timers.tick(16000);await rejected;t.mock.timers.reset();
});

test('refresh UI guards duplicate clicks, retains last success on failure, and sends only requested ranges', async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const start=html.indexOf('  let bogamSyncState ='),end=html.indexOf("  migrateNode('appointmentsRevision'",start);
  const gate=deferred(),requests=[],elements=new Map();
  for(const id of ['bogamSyncBtn','bogamSyncStatus','bogamSyncLastApplied','bogamVisitsStart','bogamVisitsEnd','bogamBookingsStart','bogamBookingsEnd']) elements.set(id,{value:id.endsWith('Start')?period.start:period.end});
  const c=vm.createContext({window:{currentMode:'input'},getAppView:()=> 'desk',isDoctorReadOnlyPage:()=>false,
    document:{getElementById:id=>elements.get(id)},AppointmentImport:require('../appointment-import'),
    localStorage:{setItem:()=>{}},migrateNode:()=>{},
    fetch:async(url,options)=>{requests.push({url,options});return gate.promise;},
    refreshDeskAppointmentButtons:()=>{},refreshAppointmentAlerts:()=>{},updateChartDbCount:()=>{} });
  vm.runInContext(html.slice(start,end),c);
  vm.runInContext("renderBogamSyncStatus({enabled:true,lastAppliedAt:'2026-11-27T03:00:00Z'})",c);
  const first=vm.runInContext('window.refreshFromBogam()',c);
  assert.equal(elements.get('bogamSyncBtn').disabled,true);
  await vm.runInContext('window.refreshFromBogam()',c);assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(requests[0].options.body),request);
  gate.resolve({ok:false,status:504,json:async()=>({code:'SYNC_TIMEOUT'})});await first;
  assert.equal(elements.get('bogamSyncBtn').disabled,false);
  assert.match(elements.get('bogamSyncStatus').textContent,/시간 초과/);
  assert.match(elements.get('bogamSyncLastApplied').textContent,/2026/);
});
