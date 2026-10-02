const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function extract(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  const start = source.slice(functionStart - 6, functionStart) === 'async ' ? functionStart - 6 : functionStart;
  assert.ok(start >= 0, name);
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
const serverFunctions = ['isRegularFixedBedNo', 'isDoctorRoomRelevantBed', 'isFixedBedRelevantBed', 'getBedsPayloadForClient', 'sseClientAllowsBed', 'sseClientAllowsState', 'stateValueForClient', 'stateChildAllowsClient', 'sseFrame', 'diffBeds', 'sseBroadcastBedsDelta', 'sseBroadcastStateChild'];
function serverContext() {
  const frames = [];
  const context = vm.createContext({
    sseClients: new Set(), sseTotals: {bedUpdateFrames:0, bedRemoveFrames:0, stateChildFrames:0},
    stateEquals: (a,b) => JSON.stringify(a) === JSON.stringify(b),
    sseSendFrame: (client, frame) => frames.push({client:client.bedNo, frame}),
  });
  load(context, server, serverFunctions);
  return {context, frames};
}
const frontendFunctions = ['getBedAssignmentAlertForBed','isFixedBedArrivalPending','getTreatmentBadgeClass','isSimultaneousTreatment','getSimultaneousGroup','shouldCompleteFollowingTreatmentTogether','getConcurrentTreatmentEndIndex','getConcurrentTreatmentNames','formatTreatmentNames','normalizePreCompletedTreatmentIndexes','getNextPendingTreatmentIndex','getRemaining','isDoctorProcedureTreatment','getDoctorProcedureAlertId','getCurrentDoctorProcedureAlertId','isDoctorProcedureAlertDismissed','isLongDoctorProcedureTreatment','isChunaDoctorProcedureTreatment','isShortDoctorProcedureTreatment','hasWaitingChunaDoctorProcedure','getUpcomingShortDoctorProcedureInfo','getCleanupShortDoctorProcedureInfo','buildDoctorProcedureAlertItemsAuto','applyDoctorAlertManualOrder','getDoctorProcedureAlertItems','getNextStaffTaskInfo'];
const active = [1,2,3,4,5,6,8,9,10,11,12,13,14,15];
function tablet(no, beds, alerts) {
  const {context:s} = serverContext();
  const client = {role:'fixed-bed',bedNo:no};
  const data = JSON.parse(JSON.stringify(s.getBedsPayloadForClient(client,beds)));
  const arrival = JSON.parse(JSON.stringify(s.stateValueForClient(client,'bedAssignmentAlerts',alerts)));
  const groups = [new Set(['핫팩']),new Set(['침','전침','왕뜸','전자뜸','적외선']),new Set(['단추','복추','벤치'])];
  const c = vm.createContext({
    selectedDoctorAlertId:'d1', ACTIVE_BED_NUMBERS:active,
    getDoctorBedNumbers:()=>[101,102], getBedData:n=>data[n], getBedLabel:n=>String(n),
    bedAssignmentAlertItems:new Map(Object.entries(arrival)),fixedBedArrivalAcknowledgedByBed:{},
    SIMULTANEOUS_TREATMENT_GROUPS:groups, SIMULTANEOUS_TREATMENTS:new Set(groups.flatMap(g=>[...g])),
  });
  load(c, html, frontendFunctions);
  return c.getNextStaffTaskInfo(no,data[no])?.item.bedNo ?? null;
}
const bed = (n,extra={})=>({patientKey:'p'+n,doctorId:'d1',treatments:['침'],currentIndex:0,timestamp:n*100,...extra});
test('all 14 independent tablets agree on pending arrival, acknowledgment and cleanup',()=>{
  const beds = Object.fromEntries(active.map(n=>[n,bed(n,{running:true,remaining:300})]));
  beds[1]=bed(1);
  const alerts={a1:{bedNo:1,patientKey:'p1'}};
  assert.deepEqual(active.map(n=>tablet(n,beds,alerts)),active.map(()=>null));
  assert.deepEqual(active.map(n=>tablet(n,beds,{})),active.map(()=>1));
  beds[1]=bed(1,{lastAlertId:'done-100'});
  beds[3]=bed(3,{treatments:['단추']});
  assert.deepEqual(active.map(n=>tablet(n,beds,{})),active.map(()=>1));
});
test('local current-treatment display gate is preserved',()=>{
  assert.equal(tablet(2,{1:bed(1),2:bed(2,{treatments:['핫팩']})},{}),null);
});
test('doctor room arrival alerts reach tablets and target the fixed or selected room popup',()=>{
 const {context:s}=serverContext();
 const alerts={room1:{bedNo:101,patientKey:'d1'},room2:{bedNo:102,patientKey:'d2'}};
 assert.deepEqual(JSON.parse(JSON.stringify(s.stateValueForClient({role:'doctor-room',room:1},'bedAssignmentAlerts',alerts))),alerts);
 const c=vm.createContext({
  URLSearchParams,window:{location:{search:'?view=bed&bed=101'}},
  getFixedDoctorBedNoFromUrl:()=>101,ACTIVE_BED_NUMBERS:active,getDoctorBedNumbers:()=>[101,102],selectedBedNo:102,
  document:{getElementById:()=>({classList:{contains:()=>true}})},
  bedAssignmentAlertItems:new Map(Object.entries(alerts)),fixedBedArrivalAcknowledgedByBed:{},getBedData:()=>({patientKey:'d1'})
 });
 load(c,html,['getFixedBedArrivalBedNo','getBedAssignmentAlertForBed','isFixedBedArrivalPending']);
 assert.equal(c.getFixedBedArrivalBedNo(),101);assert.equal(c.isFixedBedArrivalPending(101),true);
 c.fixedBedArrivalAcknowledgedByBed[101]='room1';assert.equal(c.isFixedBedArrivalPending(101),false);
 c.window.location.search='';c.getFixedDoctorBedNoFromUrl=()=>0;assert.equal(c.getFixedBedArrivalBedNo(),102);
});
test('upcoming queue crosses 120 seconds consistently without new server state',()=>{
  const beds=Object.fromEntries(active.map(n=>[n,bed(n,{running:true,remaining:300})]));
  beds[1]=bed(1,{treatments:['단추']});
  beds[3]=bed(3,{running:true,remaining:121,treatments:['핫팩','침']});
  const viewers=active.filter(n=>n!==3);
  assert.deepEqual(viewers.map(n=>tablet(n,beds,{})),viewers.map(()=>1));
  beds[3].remaining=120;
  assert.deepEqual(viewers.map(n=>tablet(n,beds,{})),viewers.map(()=>3));
});
test('1000 state changes fan out linearly; unchanged beds emit no delta',()=>{
  const {context:c,frames}=serverContext();
  active.forEach(n=>c.sseClients.add({role:'fixed-bed',bedNo:n}));
  let before={1:bed(1)};
  for(let i=0;i<1000;i++){
    const after={1:bed(1,{lastAlertId:'done-'+i})};
    const delta=c.diffBeds(before,after);
    c.sseBroadcastBedsDelta(i,delta.updates,delta.removes,before);
    before=after;
  }
  assert.equal(frames.length,1000*active.length);
  const delta=c.diffBeds(before,JSON.parse(JSON.stringify(before)));
  c.sseBroadcastBedsDelta(1001,delta.updates,delta.removes,before);
  assert.equal(frames.length,14000);
  const bytes=frames.reduce((sum,x)=>sum+Buffer.byteLength(x.frame),0);
  console.log(`SSE synthetic: 1000 changes x 14 tablets = ${frames.length} frames, ${bytes} bytes total`);
  frames.length=0;
  for(const op of ['update','delete'])c.sseBroadcastStateChild('bedAssignmentAlerts',op,'a1',op==='delete'?null:{bedNo:1,patientKey:'p1'},{bedNo:1});
  assert.equal(frames.length,28);
  frames.length=0;
  c.sseBroadcastBedsDelta(1002,[{bedNo:1,bed:bed(1,{complete:true})}],[],before);
  assert.equal(frames.length,14);
  assert.equal(frames.filter(x=>x.frame.startsWith('event: bed-remove')).length,13);
});
test('doctor rooms retain pending cleanup in reconnect snapshots',()=>{
  const {context:c}=serverContext();
  const payload=c.getBedsPayloadForClient({role:'doctor-room',bedNo:101},{1:bed(1,{lastAlertId:'done'}),2:bed(2,{complete:true})});
  assert.deepEqual(Object.keys(payload),['1']);
});


test('fixed doctor screens never prune shared alerts from filtered or initial bed snapshots', () => {
  for (const fixed of [true, false]) {
    const context = vm.createContext({
      isFixedBedScreen: () => fixed,
      hasLoadedBedsOnce: fixed,
      bedAssignmentAlertItems: new Map([['room2', {bedNo:102,patientKey:'p2'}]]),
      getBedData: () => { throw Error('must not inspect incomplete snapshots'); },
    });
    load(context, html, ['pruneStaleBedAssignmentAlerts']);
    context.pruneStaleBedAssignmentAlerts();
    assert.equal(context.bedAssignmentAlertItems.size, 1);
  }
});


test('initial and reconnect GET cannot overwrite a newer SSE snapshot', async () => {
  let resolveGet;
  const snapshots = new Map([['bedAssignmentAlerts', {pending: true}]]);
  const applied = [];
  const context = vm.createContext({
    localStateSnapshots: snapshots,
    localStateGet: () => new Promise(resolve => {resolveGet = resolve;}),
    clonePlain: value => structuredClone(value),
  });
  load(context, html, ['refreshLocalNodeSnapshot']);
  const refresh = context.refreshLocalNodeSnapshot('bedAssignmentAlerts', value => applied.push(value));
  snapshots.set('bedAssignmentAlerts', {});
  resolveGet({pending: true});
  await refresh;
  assert.equal(applied.length, 0);
  assert.deepEqual(snapshots.get('bedAssignmentAlerts'), {});
  const nextRefresh = context.refreshLocalNodeSnapshot('bedAssignmentAlerts', value => applied.push(value));
  resolveGet({fresh: true});
  await nextRefresh;
  assert.deepEqual(applied, [{fresh: true}]);
});
