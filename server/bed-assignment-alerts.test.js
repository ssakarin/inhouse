const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { reconcileAssignmentAlerts } = require('./bed-assignment-alerts');
const signageState = require('./signage-state');
const source = fs.readFileSync(`${__dirname}/server.js`, 'utf8');
const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const a = { patientKey: 'a', name: '테스트A', running: true, currentIndex: 2 };
const b = { patientKey: 'b', name: '테스트B' };

function server(beds, alerts) {
  let serial = 0;
  const state = { beds, bedAssignmentAlerts: alerts,
    signageCalls: signageState.onAssignment([], {}, beds, Date.now(), () => String(++serial)) };
  const frames = [];
  const c = vm.createContext({
    reconcileAssignmentAlerts, signageState, crypto: {randomUUID: () => String(++serial)},
    cloneJson: x => structuredClone(x), stampBedStageTimes: (_, next) => next,
    getBedsState: () => state.beds, getStateValue: key => state[key],
    setStateValue: (key, value) => {state[key] = value;},
    stateEquals: (x, y) => JSON.stringify(x) === JSON.stringify(y),
    getBedsVersion: () => state.__bedsVersion || 0, diffBeds: () => ({updates: [], removes: []}),
    sseBroadcastBedsDelta: () => frames.push('beds'),
    sseBroadcastState: (key, value) => frames.push({key, value}),
    sseBroadcastStateChild: () => frames.push('confirmation'),
    readJson: async req => req.body, normalizeStateKey: key => key,
    assertValidChartNoRecord: () => {}, jsonResponse: () => {}
  });
  vm.runInContext(source.slice(source.indexOf('function commitBeds('), source.indexOf('async function handleApi(')), c);
  const child = source.slice(source.indexOf('  const childMatch = pathname.match'), source.indexOf('  if (pathname === "/api/discharged-patients/cleanup"'));
  vm.runInContext('async function handle(req,res,pathname){' + child + '}', c);
  return {state, frames, move: beds => c.commitBeds(beds), confirm: key => c.handle(
    {method:'POST',body:{key:'bedAssignmentAlerts',childKey:key,confirmed:true}}, {}, '/api/state-child/delete')};
}

test('move keeps the same unconfirmed alert and publishes destination before confirmation calls signage once', async () => {
  const r = server({1:a}, {gold:{bedNo:1,patientKey:'a',timestamp:123}});
  r.move({1:{bedCleaning:true,previousPatientKey:'a'},8:a});
  assert.equal(r.state.bedAssignmentAlerts.gold.bedNo, 8);
  assert.equal(r.state.bedAssignmentAlerts.gold.timestamp, 123);
  assert.equal(r.state.signageCalls[0].bedNo, 8);
  assert.equal(r.state.signageCalls[0].pending, true);
  assert.equal(r.frames[0], 'beds');
  assert.equal(r.frames[1].key, 'bedAssignmentAlerts');
  assert.equal(signageState.publicStatus({}, r.state.beds, {}, r.state.signageCalls).active, null);
  await Promise.all([r.confirm('gold'), r.confirm('gold')]);
  assert.equal(Object.keys(r.state.bedAssignmentAlerts).length, 0);
  assert.equal(r.state.signageCalls.length, 1);
  const active = signageState.publicStatus({}, r.state.beds, {}, r.state.signageCalls).active;
  assert.equal(active.bedNo, 8);
});

test('swap, repeated move and doctor room move retain both patients pending alerts', async () => {
  const r = server({1:a,8:b}, {a:{bedNo:1,patientKey:'a'},b:{bedNo:8,patientKey:'b'}});
  r.move({1:b,8:a});
  assert.equal(r.state.bedAssignmentAlerts.a.bedNo,8);
  assert.equal(r.state.bedAssignmentAlerts.b.bedNo,1);
  r.move({1:b,101:a});
  assert.equal(r.state.bedAssignmentAlerts.a.bedNo,101);
  await r.confirm('a');
  assert.equal(signageState.publicStatus({},r.state.beds,{},r.state.signageCalls).active.bedNo,101);
  assert.equal(r.state.bedAssignmentAlerts.b.bedNo,1);
});

test('removing a patient clears alerts and moving an acknowledged patient does not recreate them', async () => {
  const r=server({1:a},{a:{bedNo:1,patientKey:'a'}});
  await r.confirm('a');
  r.move({8:a});
  assert.equal(Object.keys(r.state.bedAssignmentAlerts).length,0);
  assert.equal(r.state.signageCalls.length,0);
  assert.deepEqual(reconcileAssignmentAlerts({a:{bedNo:1,patientKey:'a'}},{}),{});
});

test('server clients never prune a shared alert from a partial move delta', () => {
  const c=vm.createContext({SERVER_MODE:true});
  vm.runInContext(html.slice(html.indexOf('  function pruneStaleBedAssignmentAlerts()'),html.indexOf('  async function createBedAssignmentAlert(')),c);
  // No local bed lookup or delete is permitted, even while the old bed is empty.
  c.pruneStaleBedAssignmentAlerts();
});

test('fixed and selected bed popups follow the moved alert; name click clears shared alert and calls signage', async () => {
  for (const search of ['?view=bed&bed=8', '?view=bed']) {
    const r=server({1:a},{gold:{bedNo:1,patientKey:'a',patientName:a.name}});
    r.move({8:a});
    const classes=new Set();
    const overlay={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}};
    const name={textContent:''};
    const alerts=new Map(Object.entries(r.state.bedAssignmentAlerts));
    const c=vm.createContext({
      URLSearchParams, window:{location:{search}}, selectedBedNo:8,
      document:{getElementById:id=>id==='bedArrivalOverlay'?overlay:id==='bedArrivalName'?name:{classList:{contains:()=>true}}},
      ACTIVE_BED_NUMBERS:[1,8],getDoctorBedNumbers:()=>[101,102],getFixedDoctorBedNoFromUrl:()=>0,
      getBedData:no=>r.state.beds[no],bedAssignmentAlertItems:alerts,
      fixedBedArrivalAcknowledgedByBed:{},fixedBedArrivalShownByBed:{},
      fixedBedArrivalVisiblePatientKey:'',fixedBedArrivalVisibleAlertKey:'',
      maskPatientNameForBedPopup:x=>x,requestBedScreenWakeLock:()=>{},shouldChimeDoctorArrival:()=>false,
      renderUpcomingAlerts:()=>{},renderBedMonitors:()=>{},renderBedSelector:()=>{},renderBedDetail:()=>{},
      updateBedHeaderBedChip:()=>{},updateBedRemainingChip:()=>{},syncDoctorProcedureAlerts:()=>{},
      removeBedAssignmentAlert:async(key,confirmed)=>{assert.equal(confirmed,true);await r.confirm(key);},
      showToast:()=>{},console
    });
    const from=html.indexOf('  function getFixedBedArrivalBedNo()');
    const to=html.indexOf('\n</script>',from);
    // Supply the chime predicate above; its real implementation is unrelated to movement.
    let code=html.slice(from,to);
    const chimeStart=code.indexOf('  function shouldChimeDoctorArrival(');
    const chimeEnd=code.indexOf('  function syncFixedBedArrivalOverlay()',chimeStart);
    code=code.slice(0,chimeStart)+code.slice(chimeEnd);
    vm.runInContext(code,c);
    c.syncFixedBedArrivalOverlay();
    assert.equal(classes.has('show'),true);
    assert.equal(name.textContent,a.name);
    assert.equal(c.isFixedBedArrivalPending(8),true);
    await c.window.openFixedBedArrival();
    assert.equal(classes.has('show'),false);
    assert.equal(c.isFixedBedArrivalPending(8),false);
    assert.equal(Object.keys(r.state.bedAssignmentAlerts).length,0);
    assert.equal(signageState.publicStatus({},r.state.beds,{},r.state.signageCalls).active.bedNo,8);
  }
});
