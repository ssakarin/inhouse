const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');
const regular = [1,2,3,4,5,6,8,9,10,11,12,13,14];
const context = {
  REGULAR_BED_NUMBERS: regular,
  getTodayKey: () => '2026-07-01',
  normalizePatientPositions: value => Array.isArray(value) ? value : [value].filter(Boolean),
  isCleaningBed: bed => bed.cleaning === true
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function normalizeBedPreferences'), source.indexOf('  function getActiveRoundRobinNurses')), context);
const patient = (gender = '여', preferences = {}, position = '') => ({gender, bodyParts:{position, bedPreferences:preferences}});
const occupant = gender => ({patientKey:gender, gender});
const order = (p, beds = {}, date = '2026-07-01') => Array.from(context.getPreferredBedOrder(p, beds, date));
const onlyEmpty = numbers => Object.fromEntries(regular.filter(no => !numbers.includes(no)).map(no => [no, occupant('여')]));

test('initial zones and overflow use low beds before empty opposite-zone rooms', () => {
  assert.equal(order(patient())[0], 1);
  assert.equal(order(patient('남'))[0], 8);
  const beds = Object.fromEntries([1,2,3,4,5,6].map(no => [no, occupant('여')]));
  assert.equal(order(patient(), beds)[0], 13);
});
test('same-sex rooms are filled and mixed rooms are last even in the default zone', () => {
  assert.equal(order(patient(), {3:occupant('여')})[0], 4);
  assert.equal(order(patient(), {1:occupant('남')})[0], 3);
  const beds = Object.fromEntries([1,2,3,4,5,6].map(no => [no, occupant('여')]));
  beds[9] = occupant('여');
  assert.equal(order(patient(), beds)[0], 10);
});
test('direction is mandatory; both or neither impose no restriction', () => {
  const left = [1,3,5,8,10,12,13];
  assert.ok(order(patient('여', {}, 'left_lateral')).every(no => left.includes(no)));
  assert.ok(order(patient('여', {}, 'right_lateral')).every(no => !left.includes(no)));
  assert.equal(order(patient('여', {}, ['left_lateral','right_lateral'])).length, 13);
  assert.deepEqual(order(patient('여', {}, 'left_lateral'), onlyEmpty([2,4,6])), []);
});
test('aircon exclusion applies June through September only', () => {
  for (const month of ['06','07','08','09']) {
    assert.ok(order(patient('남', {avoidAircon:true}), {}, `2026-${month}-01`).every(no => ![3,4,9,10].includes(no)));
  }
  for (const month of ['05','10']) {
    assert.ok(order(patient('남', {avoidAircon:true}), {}, `2026-${month}-01`).includes(9));
  }
});
test('low-bed preference precedes zone but falls back and does not force mixed rooms', () => {
  assert.equal(order(patient('여', {lowBed:true}))[0], 13);
  assert.equal(order(patient('여', {lowBed:true}, 'right_lateral'))[0], 14);
  assert.equal(order(patient('여', {lowBed:true}), {13:occupant('남')})[0], 1);
  assert.equal(order(patient('여', {lowBed:true}), {13:occupant('여'),14:occupant('여')})[0], 1);
});
test('preferred bed wins within tier and respects direction, aircon and mixed rooms', () => {
  assert.equal(order(patient('여', {preferredBed:5}))[0], 5);
  assert.equal(order(patient('여', {preferredBed:9}))[0], 1);
  assert.ok(!order(patient('여', {preferredBed:2}, 'left_lateral')).includes(2));
  assert.ok(!order(patient('여', {preferredBed:3,avoidAircon:true})).includes(3));
  assert.equal(order(patient('여', {preferredBed:2}), {1:occupant('남')})[0], 3);
});
test('cleaning and occupied beds are unavailable; age and memo do not change ranking', () => {
  assert.ok(!order(patient(), {1:{cleaning:true}}).includes(1));
  assert.deepEqual(order({...patient(), age:99, memo2:'에어컨X 치매 낮은베드'}), order(patient()));
});
test('body-part normalization preserves preferences across chart and form saves', () => {
  context.BODY_PARTS = {front:[], back:[]};
  context.serializePatientPositions = value => value || '';
  vm.runInContext(source.slice(source.indexOf('  function normalizeBodyParts('), source.indexOf('  function renderBodyPartSelector(')), context);
  const result = context.normalizeBodyParts({bedPreferences:{avoidAircon:true, lowBed:true, preferredBed:14}});
  assert.equal(result.bedPreferences.preferredBed, 14);
  assert.equal(result.bedPreferences.avoidAircon, true);
  assert.equal(context.normalizeBodyParts(result).bedPreferences.lowBed, true);
  assert.equal(context.normalizeBodyParts({}).bedPreferences.preferredBed, null);
});

test('queue gives low-bed access first while keeping ordinary fallback in arrival order', async () => {
  const calls = [];
  const waiting = [['early', patient()], ['low', patient('여', {lowBed:true})], ['later', patient()]];
  const ctx = {
    autoBedAssignEnabled:true, isAssigningWaitingPatients:false, shouldAssignWaitingAgain:false,
    bedAssignments:[], doctorBedMap:{}, REGULAR_BED_NUMBERS:regular, REGULAR_BED_COUNT:13,
    getHoldBedEntries:()=>[], getWaitingPatients:()=>waiting,
    normalizeBedPreferences:context.normalizeBedPreferences,
    assignPatientToBed:async (key, data, silent, force, lowOnly) => {
      calls.push([key, !!lowOnly]);
      return lowOnly ? 13 : key === 'early' ? 1 : 2;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  async function assignWaitingPatientsToBeds('), source.indexOf('  window.assignWaitingPatientsManually')), ctx);
  assert.equal(await ctx.assignWaitingPatientsToBeds(), 3);
  assert.deepEqual(calls, [['low',true], ['early',false], ['later',false]]);
  calls.length = 0;
  ctx.assignPatientToBed = async (key, data, silent, force, lowOnly) => {calls.push([key,!!lowOnly]); return lowOnly ? false : 1;};
  await ctx.assignWaitingPatientsToBeds();
  assert.deepEqual(calls, [['low',true], ['early',false], ['low',false], ['later',false]]);
});

test('fixed-bed preference control saves both bed and patient, forms schedule their normal autosave', async () => {
  const writes = [], scheduled = [];
  const bed = {patientKey:'p', bodyParts:{position:'left_lateral', bedPreferences:{lowBed:true}}};
  const ctx = {
    window:{}, console, normalizeBodyParts:context.normalizeBodyParts,
    normalizeBedPreferences:context.normalizeBedPreferences,
    formBodyPartsByScope:{desk:{}}, renderFormBodyPartSelector:()=>{},
    scheduleSelectFieldSave:scope=>scheduled.push(scope), getBedData:()=>bed,
    updateBedRecord:async(no, patch)=>writes.push(['bed', no, patch]),
    updatePatient:async(key, patch)=>writes.push(['patient', key, patch]),
    renderBodyPartSelector:()=>{}, showToast:message=>{throw Error(message);}
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  async function saveBedPreference('), source.indexOf('  window.openBedPreferencePicker')), ctx);
  const group = {dataset:{preferenceScope:'', preferenceBed:'3'}, querySelectorAll:()=>[]};
  const control = {closest:()=>group};
  await ctx.saveBedPreference(control, 'preferredBed', 5);
  assert.equal(writes[0][1], 3);
  assert.equal(writes[1][1], 'p');
  assert.equal(writes[0][2].bodyParts.bedPreferences.preferredBed, 5);
  assert.equal(writes[1][2].bodyParts.bedPreferences.lowBed, true);
  group.dataset.preferenceScope = 'desk';
  await ctx.saveBedPreference(control, 'avoidAircon', true);
  assert.equal(ctx.formBodyPartsByScope.desk.bedPreferences.avoidAircon, true);
  assert.deepEqual(scheduled, ['desk']);
});
