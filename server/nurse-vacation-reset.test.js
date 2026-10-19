const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/server.js`, 'utf8');
const start = source.indexOf('function resetNurseVacationsForNewDay(');
const end = source.indexOf('function patchObject(', start);
function setup(marker) {
  const state = {
    'settings/nurseVacationResetDate': marker,
    'staff/nurses': { a: { vacation: true, vacationWeekdays: [2], name: 'A' }, b: { vacation: false } },
    'staff/doctors': { a: { vacation: true } }
  };
  const events = [];
  const ctx = { Intl, getStateValue: key => state[key],
    setStateValue: (key, value) => { state[key] = value; },
    sseBroadcastState: (...args) => events.push(args) };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return { state, events, run: date => ctx.resetNurseVacationsForNewDay(new Date(date)) };
}
test('Korean midnight clears manual nurse absence and broadcasts, preserving schedules and doctors', () => {
  const r = setup('2026-10-16');
  r.run('2026-10-16T14:59:59Z');
  assert.equal(r.state['staff/nurses'].a.vacation, true);
  r.run('2026-10-16T15:00:00Z');
  assert.equal(r.state['staff/nurses'].a.vacation, false);
  assert.deepEqual(r.state['staff/nurses'].a.vacationWeekdays, [2]);
  assert.equal(r.state['staff/doctors'].a.vacation, true);
  assert.equal(r.events.length, 1);
  r.state['staff/nurses'].a.vacation = true;
  r.run('2026-10-16T15:00:01Z');
  assert.equal(r.state['staff/nurses'].a.vacation, true);
});
test('restart after multiple days clears stale checks', () => {
  const r = setup('2026-10-12');
  r.run('2026-10-16T00:00:00Z');
  assert.equal(r.state['staff/nurses'].a.vacation, false);
});
test('first installation preserves existing checks and records the date', () => {
  const r = setup(null);
  r.run('2026-10-16T00:00:00Z');
  assert.equal(r.state['staff/nurses'].a.vacation, true);
  assert.equal(r.state['settings/nurseVacationResetDate'], '2026-10-16');
});
