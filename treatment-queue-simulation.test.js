const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');

function extract(name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  const start = source.slice(at - 6, at) === 'async ' ? at - 6 : at;
  const rest = source.slice(start);
  for (const match of rest.matchAll(/^\s*}\r?$/gm)) {
    const code = rest.slice(0, match.index + match[0].length);
    try { new vm.Script(code); return code; } catch {}
  }
  throw new Error(`Cannot extract ${name}`);
}
function windowFunction(name, nextName) {
  return source.slice(source.indexOf(`  window.${name} =`), source.indexOf(nextName, source.indexOf(`  window.${name} =`)));
}
const clone = value => JSON.parse(JSON.stringify(value));

function simulation({ auto = true, target = 101, timed = false, delayed = false, from = 3 } = {}) {
  const next = target === 15 ? '스파인' : '약침4';
  let serverBeds = {
    [from]: { patientKey: 'moving', name: '치료환자', doctorId: 'd1', treatments: [timed ? '핫팩' : '진료', next], currentIndex: 0, running: timed, remaining: 0 },
    [target]: { patientKey: 'busy', name: '사용중' }
  };
  let localBeds = clone(serverBeds);
  const regular = [1,2,3,4,5,6,8,9,10,11,12,13,14];
  const c = vm.createContext({
    window: {}, console, Date, autoBedAssignEnabled: auto,
    isAssigningWaitingPatients: false, shouldAssignWaitingAgain: false,
    isProcessingHoldBedReleases: false, finishingBeds: new Set(), queuedTimerAlerts: new Set(), seenTimerAlerts: new Set(),
    HOLD_BED_NUMBERS: Array.from({length:20}, (_,i)=>901+i), REGULAR_BED_NUMBERS: regular, REGULAR_BED_COUNT: regular.length,
    getBedsSnapshotForRouting: async () => clone(serverBeds),
    getBedData: no => localBeds[no], getBedDataForRouting: (no,beds) => beds ? beds[no] : localBeds[no],
    getHoldBedEntries: () => Object.entries(localBeds).filter(([no])=>Number(no)>=901).map(([no,bed])=>({bedNo:Number(no),bed})),
    patientsByKey: new Map(),
    getWaitingPatients: (assigned = []) => [...c.patientsByKey].filter(([key]) => !assigned.includes(key)),
    getDoctorBedNoForPatient: id => id === 'd2' ? 102 : 101,
    isCleaningBed: bed => Boolean(bed?.bedCleaning),
    getActiveNeedleSafety: () => null, getConcurrentTreatmentSeconds: () => 300, getRemaining: bed => bed.remaining,
    showToast: () => {}, showTimerCompleteAlert: () => {}, clearLocalTimerAlertsForBed: () => {},
    updatePatientBedNoForBed: async () => {}, remapBedAssignmentAlertForMovedPatient: async () => {}, remapLocalAlertBedNo: () => {},
    nurseAutoAssignEnabled: false, createBedAssignmentAlert: async () => {},
    createBedAssignment: (key,data) => ({...data,patientKey:key,currentIndex:0}),
    applyRoundRobinNurse: async (key,data) => data, updatePatient: async () => {},
    AUTO_ASSIGN_EXCLUDED_BED_NUMBERS: new Set([7,15]), getPreferredBedOrder: () => regular,
    ACTIVE_BED_NUMBERS: [...regular,15], getDoctorBedNumbers: () => [101,102],
    findEmptyHoldBedNo: () => c.HOLD_BED_NUMBERS.find(no=>!localBeds[no]),
    getBedLabel: no => String(no),
    renderBedDetail: () => {}, renderBedMonitors: () => {},
    createBedCleaningRecord: (from, bed, to) => ({bedCleaning:true,previousPatientKey:bed.patientKey,movedToBedNo:to}),
    SIMULTANEOUS_TREATMENT_GROUPS: [new Set(['핫팩']), new Set(['침','전침','왕뜸','전자뜸','적외선']), new Set(['단추','복추','벤치'])],
    SIMULTANEOUS_TREATMENTS: new Set(['핫팩','침','전침','왕뜸','전자뜸','적외선','단추','복추','벤치'])
  });
  function sync() {
    localBeds = clone(serverBeds);
    c.bedAssignments = Array.from({length:15},(_,i)=>localBeds[i+1]||null);
    c.doctorBedMap = Object.fromEntries(Object.entries(localBeds).filter(([no])=>Number(no)>=101&&Number(no)<901));
  }
  async function transaction(mutator) {
    const result = mutator(clone(serverBeds));
    if (result !== undefined) { serverBeds = result; if (!delayed) sync(); }
    return { committed: result !== undefined, snapshot: { val: () => clone(serverBeds) } };
  }
  c.runBedsRecordTransaction = transaction;
  c.runBedRecordTransaction = async (no, mutator) => {
    const result = await transaction(beds => {
      const next = mutator(beds[no] || null);
      if (next === undefined) return undefined;
      if (next === null) delete beds[no]; else beds[no] = next;
      return beds;
    });
    return { committed:result.committed, snapshot:{val:()=>clone(serverBeds[no]||null)} };
  };
  c.updateBedRecord = async (no,patch) => transaction(beds => { beds[no] = {...beds[no],...patch}; return beds; });
  for (const name of ['isSimultaneousTreatment','getSimultaneousGroup','shouldCompleteFollowingTreatmentTogether','getConcurrentTreatmentEndIndex','getConcurrentTreatmentStartIndex','getConcurrentTreatmentNames','formatTreatmentNames','normalizePreCompletedTreatmentIndexes','getNextPendingTreatmentIndex','maybeAutoMoveBedForNextTreatment','moveToHoldBed','processHoldBedReleases','assignPatientToBed','assignWaitingPatientsToBeds','assignWaitingPatientToHoldBed','assignWaitingPatientToSpecificBed','finishBedStep']) vm.runInContext(extract(name),c);
  vm.runInContext(windowFunction('moveOrSwapBed', '  window.moveBedToWaiting ='),c);
  vm.runInContext(windowFunction('moveTreatment', '  window.completeNoTimerTreatment ='),c);
  vm.runInContext(windowFunction('completeNoTimerTreatment', '  function parseTimerEditSeconds'),c);
  vm.runInContext(windowFunction('acknowledgeBedAlert', '  window.closeTimerAlert ='),c);
  sync();
  return { c, beds:()=>serverBeds, sync, free:async()=>{delete serverBeds[target];sync();await c.processHoldBedReleases();}, next, target, from };
}

for (const auto of [false,true]) for (const target of [101,15]) {
  test(`auto=${auto}, target=${target}: actual completion -> hold -> actual move -> release`, async () => {
    const s=simulation({auto,target});
    await s.c.window.completeNoTimerTreatment(3);
    assert.equal(s.beds()[901].patientKey,'moving');
    assert.equal(s.beds()[901].currentIndex,1);
    assert.equal(s.beds()[3].bedCleaning,true);
    assert.equal(s.beds()[target].patientKey,'busy');
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
    assert.equal(s.beds()[901],undefined);
    assert.equal(s.beds()[target].pendingTargetBedNo,null);
  });
  test(`auto=${auto}, target=${target}: timer expiry stays until acknowledgment, then holds and releases`, async () => {
    const s=simulation({auto,target,timed:true});
    await s.c.finishBedStep(3);
    assert.equal(s.beds()[3].currentIndex,1);
    assert.ok(s.beds()[3].lastAlertId);
    assert.equal(s.beds()[901],undefined);
    await s.c.window.acknowledgeBedAlert(3);
    assert.equal(s.beds()[901].patientKey,'moving');
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
  });
}

for (const target of [101,15]) {
  test(`target=${target}: '이후 치료' queues and releases the next treatment`,async()=>{
    const s=simulation({target});
    await s.c.window.moveTreatment(3,1);
    await s.c.processHoldBedReleases();
    assert.equal(s.beds()[3].bedCleaning,true);
    assert.equal(s.beds()[901].currentIndex,1);
    assert.equal(s.beds()[901].patientKey,'moving');
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
  });
  test(`delayed SSE target=${target}: no-timer completion saves correct next step in hold`,async()=>{
    const s=simulation({target,delayed:true});
    await s.c.window.completeNoTimerTreatment(3);
    assert.equal(s.beds()[901].currentIndex,1);
    s.sync();
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
  });
}

test('completing spine-room treatment routes to occupied doctor-room hold',async()=>{
  const s=simulation({from:15,target:101});
  await s.c.window.completeNoTimerTreatment(15);
  assert.equal(s.beds()[15],undefined);
  assert.equal(s.beds()[901].currentIndex,1);
  assert.equal(s.beds()[901].patientKey,'moving');
  await s.free();
  assert.equal(s.beds()[101].patientKey,'moving');
});

for (const earlierInitial of [false,true]) {
  test(`actual auto-assignment and release share FIFO, initial earlier=${earlierInitial}`, async()=>{
    const s=simulation();
    await s.c.window.completeNoTimerTreatment(3);
    const queued=s.beds()[901].holdQueuedAt;
    s.c.patientsByKey.set('initial',{name:'초진환자',visitType:'초진',doctorId:'d1',timestamp:queued+(earlierInitial?-100:100)});
    await s.free();
    assert.equal(s.beds()[101].patientKey,earlierInitial?'initial':'moving');
    assert.equal(Boolean(s.beds()[901]),earlierInitial);
    if (earlierInitial) {
      s.c.patientsByKey.delete('initial'); // Completed visit leaves the waiting working set.
      await s.free(); assert.equal(s.beds()[101].patientKey,'moving');
    }
  });
}

test('actual assignments to other doctor/general beds do not block occupied spine hold or duplicate it',async()=>{
  const s=simulation({target:15});
  await s.c.window.completeNoTimerTreatment(3);
  s.c.patientsByKey.set('initial',{name:'초진',visitType:'초진',doctorId:'d2',timestamp:1});
  s.c.patientsByKey.set('regular',{name:'재진',visitType:'재진',timestamp:2});
  s.c.patientsByKey.set('moving',{name:'치료환자',visitType:'재진',timestamp:3});
  await s.c.processHoldBedReleases();
  assert.equal(s.beds()[102].patientKey,'initial');
  assert.equal(s.beds()[1].patientKey,'regular');
  assert.equal(s.beds()[901].patientKey,'moving');
  assert.equal(Object.values(s.beds()).filter(b=>b.patientKey==='moving').length,1);
  await s.free();
  assert.equal(s.beds()[15].patientKey,'moving');
});

for (const target of [101,15]) {
  test(`manual waiting-patient insertion into occupied ${target} joins behind existing hold`,async()=>{
    const s=simulation({target});
    await s.c.window.completeNoTimerTreatment(3);
    await s.c.updateBedRecord(901,{holdQueuedAt:Date.now()-1000});
    s.c.patientsByKey.set('inserted',{name:'추가환자',timestamp:1});
    assert.equal(await s.c.assignWaitingPatientToSpecificBed('inserted',target),true);
    assert.equal(s.beds()[target].patientKey,'busy');
    assert.equal(s.beds()[902].patientKey,'inserted');
    assert.equal(s.beds()[902].pendingTargetBedNo,target);
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
    assert.equal(s.beds()[902].patientKey,'inserted');
    await s.free();
    assert.equal(s.beds()[target].patientKey,'inserted');
  });

  test(`manual bed-patient insertion into occupied ${target} swaps occupants and preserves hold`,async()=>{
    const s=simulation({target});
    await s.c.window.completeNoTimerTreatment(3);
    await s.c.updateBedRecord(4,{patientKey:'inserted',name:'추가환자'});
    assert.equal(await s.c.window.moveOrSwapBed(4,target,{silent:true}),true);
    await s.c.processHoldBedReleases();
    assert.equal(s.beds()[target].patientKey,'inserted');
    assert.equal(s.beds()[4].patientKey,'busy');
    assert.equal(s.beds()[901].patientKey,'moving');
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
  });

  test(`manual assignment to empty ${target} can precede queued release without overwriting hold`,async()=>{
    const s=simulation({target});
    await s.c.window.completeNoTimerTreatment(3);
    await s.c.runBedsRecordTransaction(beds=>{delete beds[target];return beds;});
    s.sync();
    s.c.patientsByKey.set('inserted',{name:'추가환자',timestamp:1});
    await s.c.assignWaitingPatientToSpecificBed('inserted',target);
    await s.c.processHoldBedReleases();
    assert.equal(s.beds()[target].patientKey,'inserted');
    assert.equal(s.beds()[901].patientKey,'moving');
    await s.free();
    assert.equal(s.beds()[target].patientKey,'moving');
  });
}

for (const treatment of ['단추','복추','SW','약침4']) for (const occupied of [false,true]) {
  test(`spine -> doctor: ${treatment}, occupied=${occupied}`,async()=>{
    const s=simulation({from:15,target:101});
    await s.c.updateBedRecord(15,{treatments:['스파인',treatment]});
    if (!occupied) await s.free();
    await s.c.window.moveTreatment(15,1);
    assert.equal(s.beds()[15],undefined);
    assert.equal(s.beds()[occupied?901:101].patientKey,'moving');
  });
}

test('previous-treatment navigation does not route patients',async()=>{
  const s=simulation();
  await s.c.updateBedRecord(3,{treatments:['약침4','진료'],currentIndex:1});
  await s.c.window.moveTreatment(3,-1);
  assert.equal(s.beds()[3].currentIndex,0);
  assert.equal(s.beds()[901],undefined);
});

test('next-treatment navigation uses saved patch even before SSE updates arrive',async()=>{
  const s=simulation({delayed:true});
  await s.c.window.moveTreatment(3,1);
  assert.equal(s.beds()[901].currentIndex,1);
  assert.equal(s.beds()[901].pendingTargetBedNo,101);
});
