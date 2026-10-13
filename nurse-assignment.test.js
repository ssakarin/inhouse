const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('  function getRoundRobinStartOffset');
const end = source.indexOf('  async function recordManualNurseAssignment', start);
function setup(initial, active = ['a', 'b', 'c'], beds = {}) {
  let state = structuredClone(initial), roster = active;
  const context = { console, getTodayKey: () => '2026-10-13',
    getActiveRoundRobinNurses: () => roster.map(id => [id, {name: id}]),
    getCurrentNurseBedCounts: () => beds,
    localStateGet: async () => structuredClone(state),
    localStatePut: async (_, value) => {state = structuredClone(value);} };
  vm.createContext(context); vm.runInContext(source.slice(start,end), context);
  return {pick: () => context.getNextFairNurse(), state: () => state, roster: ids => {roster = ids;}};
}
const current = assignments => ({lastDate:'2026-10-13',startId:'',startOffset:0,todayAssignments:assignments,activeNurseIds:['a','b']});
test('afternoon join is aligned to 5/5 before picking, then all three share assignments', async () => {
  const run=setup(current({a:5,b:5,c:0}));
  const picks=[];for(let i=0;i<3;i++)picks.push((await run.pick()).id);
  assert.deepEqual(picks,['a','b','c']);
  assert.deepEqual(run.state().todayAssignments,{a:6,b:6,c:6});
  assert.deepEqual(run.state().activeNurseIds,['a','b','c']);
});
test('legacy state without roster aligns an unrecorded afternoon nurse',async()=>{
 const state=current({a:5,b:5});delete state.activeNurseIds;
 const run=setup(state);await run.pick();assert.equal(run.state().todayAssignments.c,5);
});
test('joining baseline uses floor average and never lowers a higher count',async()=>{
 const run=setup(current({a:5,b:6,c:9}));await run.pick();assert.equal(run.state().todayAssignments.c,9);
 const lower=setup(current({a:5,b:6,c:0}));await lower.pick();assert.equal(lower.state().todayAssignments.c,5);
});
test('current bed load remains part of fair selection after alignment',async()=>{
 const run=setup(current({a:5,b:5,c:0}),['a','b','c'],{a:2,b:1});
 assert.equal((await run.pick()).id,'c');assert.equal(run.state().todayAssignments.c,6);
});
test('next day resets counts instead of carrying the joining baseline',async()=>{
 const state=current({a:20,b:20,c:0});state.lastDate='2026-10-12';
 const run=setup(state);await run.pick();assert.equal(Object.values(run.state().todayAssignments).reduce((a,b)=>a+b,0),1);
});
test('return after exclusion aligns again and excluded nurses cannot be picked',async()=>{
 const run=setup(current({a:5,b:5,c:0}),['a','b']);
 await run.pick();run.roster(['a','b','c']);await run.pick();assert.equal(run.state().todayAssignments.c,5);
});
