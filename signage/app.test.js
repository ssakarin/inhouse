const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('returning from a call rebuilds advertising layout and fits the full stage', () => {
  const operations = [];
  const stage = {style:{},get offsetHeight(){operations.push('layout');return 3840;}};
  const advertising = {style:{set display(value){operations.push(value);}}};
  const slides = [0,1].map(() => ({classList:{toggle(){}},setAttribute(){},getAttribute(){return '10000';}}));
  const window = {innerWidth:1080,innerHeight:1920,addEventListener(){},setTimeout(){},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./app.js'),'utf8'),{
    window,Date,
    document:{documentElement:{classList:{add(){}}},getElementById:()=>stage,querySelectorAll:()=>slides,querySelector:()=>advertising,addEventListener(){}}
  });
  assert.deepEqual(operations,['none','layout','']);
  operations.length = 0;
  stage.style.transform = 'scale(0.1)';
  window.restoreSignageAdvertising();
  assert.deepEqual(operations,['none','layout','']);
  assert.equal(stage.style.transform,'scale(0.5)');
  assert.equal(stage.style.marginLeft,'0px');
});
