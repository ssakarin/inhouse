const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { accumulateTreatmentChange: change, acknowledgeTreatmentChange: ack } = require('./treatment-change-alerts');
const patient = treatments => ({ patientKey: 'p', name: '홍길동', chartNo: '1234', treatments });
const a = patient(['전침', '습부항', '약침1']);
const b = patient(['전침', '습부항', '약침4']);

test('unconfirmed replacements merge, cancel, and ignore order and settings', () => {
 const first = change(undefined, a, b, 1, 100, 'v1');
 assert.deepEqual(first.changes, [{name:'약침1',amount:-1},{name:'약침4',amount:1}]);
 const c = patient(['전침', '습부항', '약침2']);
 const merged = change(first, b, c, 8, 200, 'v2');
 assert.deepEqual(merged.changes, [{name:'약침1',amount:-1},{name:'약침2',amount:1}]);
 assert.equal(merged.timestamp,100);
 assert.equal(change(merged,c,a,8),null);
 assert.equal(change(first,b,{...b,treatments:[...b.treatments].reverse(),spineSettings:{foo:1}},8),first);
});
test('duplicate counts, desk edits, confirmation races and movement preserve semantics', () => {
 const first=change(undefined,patient(['침']),patient(['침','침']),1,100,'v1');
 assert.deepEqual(first.changes,[{name:'침',amount:1}]);
 // Desk removed 습부항: only the next room change (약침4 -> 약침2) joins.
 const initial=change(undefined,a,b,1,100,'v1');
 const merged=change(initial,patient(['전침','약침4']),patient(['전침','약침2']),8,200,'v2');
 assert.ok(!merged.changes.some(x=>x.name==='습부항'));
 assert.equal(ack(merged,'v1'),merged);
 const confirmed=ack(merged,'v2',300);
 assert.equal(change(confirmed,patient(['전침','약침2']),patient(['약침2','전침']),9),confirmed);
 const fresh=change(confirmed,patient(['전침','약침2']),patient(['전침','약침3']),9,400,'v3');
 assert.equal(fresh.acknowledgedAt,null);
 assert.equal(fresh.timestamp,400);
 assert.deepEqual(fresh.changes,[{name:'약침2',amount:-1},{name:'약침3',amount:1}]);
 assert.equal(change(initial,{},b,2),initial);
 assert.equal(change(initial,a,{...b,patientKey:'other'},2),initial);
});

const source=fs.readFileSync(`${__dirname}/server.js`,'utf8');
const start=source.indexOf('  if (pathname === "/api/treatment-desk-alerts/acknowledge"');
const end=source.indexOf('  if (pathname === "/api/beds/update-child"',start);
function server() {
 const state={beds:{1:a}}, broadcasts=[], transactions=[];
 const c=vm.createContext({
   accumulateTreatmentChange:change,acknowledgeTreatmentChange:ack,
   readJson:async req=>req.body,assertValidChartNoRecord:()=>{},cloneJson:structuredClone,
   getBedsState:()=>state.beds,getBedsVersion:()=>1,
   getStateValue:key=>state[key],setStateValue:(key,value)=>state[key]=value,
   sseBroadcastState:(key,value)=>broadcasts.push([key,value]),
   stateEquals:(x,y)=>JSON.stringify(x)===JSON.stringify(y),sseTotals:{bedsNoopWrites:0},
   stateValueCache:new Map(),db:{exec:sql=>transactions.push(sql)},
   commitBeds:(beds,prev,deferred)=>{state.beds=beds; deferred.push(()=>{});return 2;},
   jsonResponse:()=>{}
 });
 const run=vm.runInContext(`(async function(req,res,pathname){${source.slice(start,end)}})`,c);
 return {state,broadcasts,transactions,post:(path,body)=>run({method:'POST',body},{},path)};
}
test('server persists treatment alert with bed edit, excludes desk, and confirms exact version',async()=>{
 const s=server();
 await s.post('/api/beds/update',{bedNo:1,patch:{treatments:b.treatments},treatmentChangeSource:'treatment-room'});
 assert.equal(s.state.treatmentDeskAlerts.p.name,'홍길동');
 assert.deepEqual(s.transactions,['BEGIN IMMEDIATE','COMMIT']);
 const alert=s.state.treatmentDeskAlerts.p;
 await s.post('/api/beds/update',{bedNo:1,patch:{treatments:['전침','약침4']},treatmentChangeSource:'desk'});
 assert.equal(s.state.treatmentDeskAlerts.p,alert);
 // A move is a CAS path, followed by metadata-only bed writes.
 s.state.beds[8]=s.state.beds[1];delete s.state.beds[1];
 await s.post('/api/beds/update',{bedNo:8,patch:{nurseId:'n'},treatmentChangeSource:'treatment-room'});
 assert.equal(s.state.treatmentDeskAlerts.p,alert);
 await s.post('/api/treatment-desk-alerts/acknowledge',{patientKey:'p',version:'stale'});
 assert.equal(s.state.treatmentDeskAlerts.p,alert);
 await s.post('/api/treatment-desk-alerts/acknowledge',{patientKey:'p',version:alert.version});
 assert.ok(s.state.treatmentDeskAlerts.p.acknowledgedAt);
 assert.equal(s.broadcasts.length,2);
});

test('desk cards show deletions first, preserve unseen alerts and sink confirmed cards', () => {
 const html=fs.readFileSync(`${__dirname}/../index.html`,'utf8');
 const begin=html.indexOf('    const treatmentChangeItems =');
 const end=html.indexOf('    const appointmentAlertItems =',begin);
 const old=Date.now()-3*86400000;
 const items=[
  {patientKey:'p',name:'홍길동',chartNo:'1234',version:'v1',timestamp:old,changes:[{name:'약침4',amount:1},{name:'약침1',amount:-1}]},
  {patientKey:'q',name:'확인환자',chartNo:'2',version:'v2',timestamp:1,acknowledgedAt:Date.now(),changes:[{name:'침',amount:-1}]},
  {patientKey:'r',name:'과거확인',version:'v3',acknowledgedAt:old,changes:[{name:'침',amount:1}]}
 ];
 const date=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const c=vm.createContext({treatmentDeskAlertItems:new Map(items.map(x=>[x.patientKey,x])),matchesDoctorPageRecord:()=>true,getTodayKey:date,escapeHtml:String,escapeHtmlJsString:JSON.stringify});
 const rendered=vm.runInContext(`${html.slice(begin,end)}\ntreatmentChangeItems`,c);
 assert.equal(rendered.length,2);
 assert.equal(rendered[0].alertPriority,-2);
 assert.ok(rendered[0].html.includes('홍길동(1234)'));
 assert.ok(rendered[0].html.indexOf('약침1')<rendered[0].html.indexOf('약침4'));
 assert.equal(rendered[1].alertPriority,2);
 assert.match(rendered[1].html,/disabled/);
 assert.match(html,/const inputItems = \[\.\.\.treatmentChangeItems,/);
});

test('doctor edits produce alerts despite sharing input mode; only desk edits are excluded', async () => {
 const html=fs.readFileSync(`${__dirname}/../index.html`,'utf8');
 const start=html.indexOf('  async function updateBedRecord(');
 const end=html.indexOf('  async function updateBedChildRecord(',start);
 for(const [view,mode,expected] of [
  ['doctor','input','treatment-room'],['doctor','doctor','treatment-room'],
  ['desk','input','desk'],['','input','desk'],
  ['clinic','receive','treatment-room'],['bed','bed','treatment-room'],
  ['','receive','treatment-room'],['','doctor','treatment-room']
 ]) {
  const requests=[];
  const c=vm.createContext({getAppView:()=>view,window:{currentMode:mode},localBedsRequest:async(path,body)=>requests.push(body)});
  vm.runInContext(html.slice(start,end),c);
  await c.updateBedRecord(1,{treatments:['침']});
  assert.equal(requests[0].treatmentChangeSource,expected,`${view}/${mode}`);
 }
});


test('daily cleanup deletes old treatment alerts regardless of acknowledgement and persists today', async () => {
 const html=fs.readFileSync(`${__dirname}/../index.html`,'utf8');
 const start=html.indexOf('  async function cleanupStaleTreatmentDeskAlerts(');
 const end=html.indexOf('  function syncAppointmentDeskAlertsForCurrentDate(',start);
 const today='2026-11-28';
 const items=new Map([
  ['oldPending',{timestamp:'2026-11-27',acknowledgedAt:null}],
  ['oldConfirmed',{timestamp:'2026-11-27',acknowledgedAt:1}],
  ['todayPending',{timestamp:today}],
  ['todayConfirmed',{timestamp:today,acknowledgedAt:1}]
 ]);
 const writes=[];
 const c=vm.createContext({window:{getAppView:()=> 'desk'},treatmentDeskAlertItems:items,
  getTodayKey:()=>today,isTimestampOnDate:(timestamp,date)=>timestamp===date,
  renderUpcomingAlerts:()=>{},setLocalNode:async(key,value)=>writes.push([key,value]),console});
 await vm.runInContext(`${html.slice(start,end)}\ncleanupStaleTreatmentDeskAlerts()`,c);
 assert.deepEqual([...items.keys()],['todayPending','todayConfirmed']);
 assert.equal(writes.length,1);
 assert.equal(writes[0][0],'treatmentDeskAlerts');
 assert.deepEqual(Object.keys(writes[0][1]),['todayPending','todayConfirmed']);
 await vm.runInContext('cleanupStaleTreatmentDeskAlerts()',c);
 assert.equal(writes.length,1);
 assert.match(html,/cleanupStaleAppointmentDeskAlerts\(today\);\s*cleanupStaleTreatmentDeskAlerts\(today\);/);
 assert.match(html,/cleanupStaleTreatmentDeskAlerts\(getTodayKey\(\)\);/);
});
