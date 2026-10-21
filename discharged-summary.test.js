const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');
const context = {
  getSortedStaff: () => [['a', { name: '김' }], ['b', { name: '허' }]],
  toLocalDateInputValue: () => '2026-10-21',
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function getPatientLatestVisitDate('), source.indexOf('  function getDaysSinceVisitDate(')), context);
vm.runInContext(source.slice(source.indexOf('  function summarizeDischargedPatients('), source.indexOf('  function renderDischargedPatientsList(')), context);
const summarize = patients => JSON.parse(JSON.stringify(context.summarizeDischargedPatients(patients)));

test('separates first and returning initial visits, excluding ordinary return visits', () => {
  const counts = summarize([
    { visitType: '초진', visitDates: ['2026-10-21'], doctorId: 'a' },
    { visitType: '초진', visitHistory: { '2026-01-01': {}, '2026-10-21': {} }, doctorId: 'a' },
    { visitType: '초진', lastVisitDate: '2026-02-01', doctorName: '허' },
    { visitType: '재초진', doctorId: 'b' },
    { visitType: '재진' },
  ]);
  assert.equal(counts.total, 5);
  assert.equal(counts.newCount, 1);
  assert.equal(counts.reinitialCount, 3);
  assert.deepEqual(counts.doctors, [{ name: '김', count: 2 }, { name: '허', count: 2 }, { name: '미지정', count: 1 }]);
});

test('includes zero counts and retains doctors no longer in staff settings', () => {
  assert.deepEqual(summarize([]), { total: 0, newCount: 0, reinitialCount: 0, doctors: [{ name: '김', count: 0 }, { name: '허', count: 0 }] });
  const counts = summarize([{ visitType: '재진', doctorId: 'old', doctorName: '이' }]);
  assert.deepEqual(counts.doctors[2], { name: '이', count: 1 });
  assert.equal(counts.doctors.reduce((sum, doctor) => sum + doctor.count, 0), counts.total);
});
