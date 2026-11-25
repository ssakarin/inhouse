const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');
const patient = key => ({ patientKey:key, name:key, doctorId:'d', treatments:['침','스파인'], currentIndex:1, total:300, remaining:123, running:true, startedAt:1000, lastAlertId:key+'-alert', nurseId:'' });
function setup(from, to, target, changeBeforeCommit) {
  const beds = { [from]:patient('a'), ...(target ? {[to]:target} : {}) };
  const writes = [], nurseCalls = [], alerts = [], alertOptions = [];
  const c = {
    window:{}, HOLD_BED_NUMBERS:[901,902], nurseAutoAssignEnabled:true, autoBedAssignEnabled:false,
    getDoctorBedNoForPatient:()=>101,
    updateBedRecord:async(no,patch)=>Object.assign(beds[no],patch),
    getHoldBedEntries:()=>Object.entries(beds).filter(([no])=>Number(no)>=901).map(([no,bed])=>({bedNo:Number(no),bed})),
    getBedData:no => beds[no], getBedsSnapshotForRouting:async()=>null,
    getBedDataForRouting:no=>beds[no], isCleaningBed:bed=>Boolean(bed?.bedCleaning),
    createBedCleaningRecord:(from,bed,to)=>({bedCleaning:true,previousPatientKey:bed.patientKey,movedToBedNo:to}),
    runBedsRecordTransaction:async mutate=>{
      if(changeBeforeCommit) changeBeforeCommit(beds);
      const next=mutate(structuredClone(beds));
      if(next){for(const k of Object.keys(beds))delete beds[k];Object.assign(beds,next);}
      return {committed:Boolean(next),snapshot:{val:()=>structuredClone(beds)}};
    },
    updatePatientBedNoForBed:async(no,bed)=>{if(bed?.patientKey)writes.push([bed.patientKey,Number(no)]);},
    applyRoundRobinNurse:async(key,bed,no)=>{nurseCalls.push([key,Number(no)]);Object.assign(beds[no],{nurseId:'n',nurseName:'간호사'});return beds[no];},
    updatePatient:async()=>{}, createBedAssignmentAlert:async(key,bed,no,options)=>{alerts.push([key,no]);alertOptions.push(options);},
    remapBedAssignmentAlertForMovedPatient:async()=>{}, remapLocalAlertBedNo:()=>{}, showToast:()=>{},getBedLabel:no=>String(no)
  };
  vm.createContext(c);
  const a=source.indexOf('  window.moveOrSwapBed = async');
  vm.runInContext(source.slice(a,source.indexOf('  window.moveBedToWaiting',a)),c);
  return {context:c,beds,writes,nurseCalls,alerts,alertOptions,move:options=>c.window.moveOrSwapBed(from,to,options)};
}

for (const target of [15, 101]) test(`holding area release creates a return popup for ${target}`, async () => {
  const s = setup(901, target);
  assert.equal(await s.move({ silent: true, requireEmptyTarget: true }), true);
  assert.deepEqual(s.alerts, [['a', target]]);
  assert.equal(s.alertOptions.length, 1);
  assert.equal(s.alertOptions[0].returnFromWaiting, true);
});
const places=[1,8,15,101,102];
for(const from of places)for(const to of places.filter(no=>no!==from)){
  test(`move ${from} -> ${to} retains patient, treatment progress and updates patient location`,async()=>{
    const s=setup(from,to); assert.equal(await s.move(),true);
    for(const field of ['patientKey','treatments','currentIndex','total','remaining','running','startedAt','lastAlertId']) assert.deepEqual(s.beds[to][field],patient('a')[field]);
    assert.deepEqual(s.writes,[['a',to]]);
    if(from<101&&from!==15)assert.equal(s.beds[from].bedCleaning,true);else assert.equal(s.beds[from],undefined);
  });
  test(`swap ${from} <-> ${to} keeps both patients and locations`,async()=>{
    const s=setup(from,to,patient('b'));assert.equal(await s.move(),true);
    assert.equal(s.beds[from].patientKey,'b');assert.equal(s.beds[to].patientKey,'a');
    assert.deepEqual(s.writes,[['b',from],['a',to]]);
    assert.equal(Object.values(s.beds).filter(b=>b.patientKey).length,2);
  });
}
test('automatic movement never swaps with an occupied destination',async()=>{
 const s=setup(1,101,patient('b'));assert.equal(await s.move({requireEmptyTarget:true}),false);assert.equal(s.beds[1].patientKey,'a');assert.equal(s.beds[101].patientKey,'b');
});
test('cleaning source or destination blocks manual movement',async()=>{
 const s=setup(1,8,{bedCleaning:true});assert.equal(await s.move(),false);
});
test('source changed while moving does not move another patient',async()=>{
 const s=setup(1,101,null,beds=>beds[1]=patient('other'));assert.equal(await s.move(),false);assert.equal(s.beds[1].patientKey,'other');assert.equal(s.beds[101],undefined);
});
test('destination changed to cleaning during transaction blocks movement',async()=>{
 const s=setup(1,8,null,beds=>beds[8]={bedCleaning:true});assert.equal(await s.move(),false);assert.equal(s.beds[1].patientKey,'a');
});
test('destination changed to a different patient does not unexpectedly swap',async()=>{
 const s=setup(1,8,null,beds=>beds[8]=patient('other'));assert.equal(await s.move(),false);assert.equal(s.beds[1].patientKey,'a');
});
for(const from of [101])test(`unassigned nurse is assigned on ${from} -> regular bed`,async()=>{
 const s=setup(from,1);await s.move();assert.deepEqual(s.nurseCalls,[['a',1]]);
});
test('reverse swap retains existing nurse assignment behavior',async()=>{
 const s=setup(1,101,patient('b'));await s.move();assert.deepEqual(s.nurseCalls,[]);
});
test('a patient with an existing nurse retains the nurse during movement',async()=>{
 const s=setup(101,1);s.beds[101].nurseId='existing';await s.move();assert.deepEqual(s.nurseCalls,[]);assert.equal(s.beds[1].nurseId,'existing');
});


for (const [from,to,treatment] of [[1,101,'단추'],[1,15,'스파인'],[101,15,'스파인'],[15,101,'단추']]) {
  for (const occupied of [false,true]) test(`actual routing ${from} -> ${to}, occupied=${occupied}`,async()=>{
    const s=setup(from,to,occupied?patient('busy'):null);
    s.beds[from].treatments=[treatment];s.beds[from].currentIndex=0;
    const c=s.context;
    vm.runInContext(source.slice(source.indexOf('  const SIMULTANEOUS_TREATMENTS_1'),source.indexOf('  function formatTreatmentNames')),c);
    vm.runInContext(source.slice(source.indexOf('  async function maybeAutoMoveBedForNextTreatment'),source.indexOf('  async function assignWaitingPatientToHoldBed')),c);
    vm.runInContext(source.slice(source.indexOf('  let isProcessingHoldBedReleases'),source.indexOf('  // 베드가 비워지거나')),c);
    await c.maybeAutoMoveBedForNextTreatment(from,s.beds[from]);
    if(occupied){
      assert.equal(s.beds[to].patientKey,'busy');
      assert.equal(s.beds[901].patientKey,'a');assert.equal(s.beds[901].pendingTargetBedNo,to);
      await c.processHoldBedReleases();assert.equal(s.beds[901].patientKey,'a');
      delete s.beds[to];await c.processHoldBedReleases();
      assert.equal(s.beds[901],undefined);assert.equal(s.beds[to].pendingTargetBedNo,null);
    }
    assert.equal(s.beds[to].patientKey,'a');assert.equal(s.beds[to].remaining,123);assert.equal(s.beds[to].running,true);
  });
}

test('spine to regular bed retains existing nurse assignment behavior',async()=>{
 const s=setup(15,1);await s.move();assert.deepEqual(s.nurseCalls,[]);
});


test('direct move after 습부항 creates a popup and confirming it starts 복추 and ends its wait', async () => {
  const { startInitialExamOnConfirmation } = require('./server/bed-assignment-alerts');
  const { stampBedStageTimes } = require('./server/bed-stage-time');
  const s = setup(1, 101);
  const now = Date.now();
  Object.assign(s.beds[1], {treatments:['습부항','복추','SW','약침4'], currentIndex:1,
    running:false, remaining:300, startedAt:null, lastAlertId:null, initialExamOnArrival:false,
    stageEnteredAt:now - 20 * 60000});
  const alerts = new Map();
  Object.assign(s.context, {bedAssignmentAlertItems:alerts, doctorLongWaitMinutes:15,
    getBedAssignmentAlertForPatient:()=>null,
    pushBedAssignmentAlert:async alert=>alerts.set('gold',alert)});
  function load(name) {
    const rest=source.slice(source.indexOf(`  function ${name}(`) >= 0
      ? source.indexOf(`  function ${name}(`) : source.indexOf(`  async function ${name}(`));
    for(const m of rest.matchAll(/^\s*}\r?$/gm)){
      const code=rest.slice(0,m.index+m[0].length);
      try {new vm.Script(code);} catch {continue;}
      vm.runInContext(code,s.context);return;
    }
    throw Error(name);
  }
  for(const name of ['createBedAssignmentAlert','isDoctorProcedureInProgress','getDoctorProcedureWaitInfo'])load(name);
  s.context.getConcurrentTreatmentNames=(ts,i)=>[ts[i]];
  assert.equal(await s.move({requireEmptyTarget:true}),true);
  assert.equal(alerts.size,1);
  const alert=alerts.get('gold');
  assert.equal(alert.bedNo,101);
  assert.equal(alert.returnFromWaiting,undefined);
  assert.equal(alert.directProcedureArrival,true);
  assert.equal(alert.treatmentName,'복추');
  assert.equal(alert.treatmentIndex,1);
  assert.equal(s.context.getDoctorProcedureWaitInfo(s.beds[101],now).waitMinutes,20);
  // Same server confirmation operation: apply automatic start, then remove the popup.
  const started=startInitialExamOnConfirmation(s.beds,alert,now);
  if(started)Object.assign(s.beds,stampBedStageTimes(s.beds,started,now));
  alerts.delete('gold');
  assert.equal(alerts.size,0);
  assert.ok(started);
  assert.equal(s.context.isDoctorProcedureInProgress(s.beds[101]),true);
  assert.equal(s.context.getDoctorProcedureWaitInfo(s.beds[101],now).longWaiting,false);
  assert.equal(s.context.getDoctorProcedureWaitInfo(s.beds[101],now+5*60000).waitMinutes,0);
  console.log('Direct move simulation: popup created -> confirmed and removed; 복추 started; wait 20 -> 0 minutes.');
});
