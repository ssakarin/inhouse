const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');

function setup(treatments, occupied = {}, from = 3) {
  const beds = { ...occupied, [from]: { patientKey: 'moving', doctorId: 'doctor', treatments, currentIndex: 0, remaining: 120 } };
  const context = {
    HOLD_BED_NUMBERS: Array.from({ length: 20 }, (_, i) => 901 + i),
    autoBedAssignEnabled: false,
    getBedData: no => beds[no],
    getBedsSnapshotForRouting: async () => null,
    getBedDataForRouting: no => beds[no],
    getDoctorBedNoForPatient: () => 101,
    isCleaningBed: bed => Boolean(bed?.bedCleaning),
    createBedCleaningRecord: (from, bed, to) => ({ bedCleaning: true, previousPatientKey: bed.patientKey, movedToBedNo: to }),
    runBedsRecordTransaction: async update => {
      const draft = structuredClone(beds);
      const result = update(draft);
      if (result) { for (const key of Object.keys(beds)) delete beds[key]; Object.assign(beds, result); }
      return { committed: Boolean(result), snapshot: { val: () => beds } };
    },
    updatePatientBedNoForBed: async () => {},
    remapBedAssignmentAlertForMovedPatient: async () => {},
    remapLocalAlertBedNo: () => {},
    updateBedRecord: async (no, patch) => Object.assign(beds[no], patch),
    getHoldBedEntries: () => Object.entries(beds).filter(([no]) => Number(no) >= 901).map(([no, bed]) => ({ bedNo: Number(no), bed })),
    window: { moveOrSwapBed: async (from, to, options) => {
      assert.equal(options.requireEmptyTarget, true);
      if (beds[to]) return false;
      beds[to] = beds[from]; delete beds[from]; return true;
    } }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  const SIMULTANEOUS_TREATMENTS_1'), source.indexOf('  function formatTreatmentNames')), context);
  vm.runInContext(source.slice(source.indexOf('  async function maybeAutoMoveBedForNextTreatment'), source.indexOf('  async function assignWaitingPatientToHoldBed')), context);
  vm.runInContext(source.slice(source.indexOf('  let isProcessingHoldBedReleases'), source.indexOf('  // 베드가 비워지거나')), context);
  return { beds, context, route: () => context.maybeAutoMoveBedForNextTreatment(from, beds[from]) };
}

for (const [treatments, target] of [[['단추'],101], [['복추'],101], [['SW'],101], [['약침4'],101], [['스파인'],15], [['단추','벤치'],15], [['복추','벤치'],15]]) {
  test(`${treatments.join('+')}: occupied destination queues patient, preserves treatment and marks old bed for cleaning`, async () => {
    const s = setup(treatments, { [target]: { patientKey: 'busy' } });
    await s.route();
    assert.equal(s.beds[target].patientKey, 'busy');
    assert.equal(s.beds[3].bedCleaning, true);
    assert.equal(s.beds[901].patientKey, 'moving');
    assert.equal(s.beds[901].pendingTargetBedNo, target);
    assert.equal(s.beds[901].remaining, 120);
    assert.equal(s.beds[901].currentIndex, 0);
    await s.context.processHoldBedReleases();
    assert.equal(s.beds[901].patientKey, 'moving');
    delete s.beds[target];
    await s.context.processHoldBedReleases();
    assert.equal(s.beds[target].patientKey, 'moving');
    assert.equal(s.beds[target].pendingTargetBedNo, null);
    assert.equal(s.beds[901], undefined);
  });
}

test('a later spine treatment does not cause premature routing', async () => {
  const s = setup(['침', '스파인']); await s.route();
  assert.equal(s.beds[3].patientKey, 'moving'); assert.equal(s.beds[15], undefined);
});

test('full hold queue leaves patient in original bed without overwriting occupants', async () => {
  const occupied = { 101: { patientKey: 'busy' } };
  for (let no = 901; no <= 920; no++) occupied[no] = { patientKey: `held-${no}` };
  const s = setup(['단추'], occupied); await s.route();
  assert.equal(s.beds[3].patientKey, 'moving'); assert.equal(s.beds[101].patientKey, 'busy');
  assert.equal(s.beds[901].patientKey, 'held-901');
});

test('spine-room patients auto-route to the doctor room', async () => {
  const s = setup(['약침4'], {}, 15); await s.route();
  assert.equal(s.beds[101].patientKey, 'moving'); assert.equal(s.beds[15], undefined);
});

test('patients already in the spine room stay there for spine or chuna with bench', async () => {
  for (const treatments of [['스파인'], ['단추','벤치']]) {
    const s = setup(treatments, {}, 15); await s.route();
    assert.equal(s.beds[15].patientKey, 'moving'); assert.equal(s.beds[901], undefined);
  }
});

test('current limitation: a patient in another doctor room stays there for chuna', async () => {
  const s = setup(['단추'], {}, 102); await s.route();
  assert.equal(s.beds[102].patientKey, 'moving'); assert.equal(s.beds[101], undefined);
});
