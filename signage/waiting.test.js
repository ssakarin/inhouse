const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('batch fills the whole display and chimes once even as more patients join', async () => {
  const elements = {}, timers = [];
  let plays = 0;
  function element(id) {
    if (elements[id]) return elements[id];
    const classes = new Set();
    return elements[id] = {
      textContent: '', hidden: false, style: {}, children: [], childElementCount: 0,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      replaceChildren() { this.children = []; this.childElementCount = 0; },
      appendChild(child) { this.children.push(child); this.childElementCount++; }
    };
  }
  class Audio {
    constructor() { this.state = 'running'; this.destination = {}; }
    resume() { return Promise.resolve(); }
    decodeAudioData(buffer, success) { success({}); }
    createBufferSource() { return {connect() {}, disconnect() {}, start() { plays++; }, stop() {}}; }
  }
  const now = Date.now();
  const call = (id, groupId = 'batch') => ({id, groupId, maskedName:'김민＊', bedLabel:'8번 베드', startAt:now, endAt:now+15000});
  let data = {serverTime:now, waitingCount:0, consultationWaitingCount:0, active:call('one'), activeCalls:[call('one'),call('two')], recent:[]};
  const context = {
    window:{AudioContext:Audio},
    document:{getElementById:element,createElement:()=>element(String(Math.random())),querySelectorAll:()=>[],addEventListener() {}},
    Intl, Date, AbortController, setInterval() {}, clearTimeout() {},
    setTimeout(fn, ms) { timers.push({fn,ms}); return timers.length; },
    fetch:async url => url.includes('.wav') ? {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)} : {ok:true,json:async()=>data}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./waiting.js'),'utf8'),context);
  await new Promise(setImmediate);
  async function poll() { await timers.filter(timer=>timer.ms===1000).at(-1).fn(); }
  await poll();
  assert.equal(plays,1);
  assert.equal(element('callingMessage').hidden,true);
  assert.equal(element('groupCalling').hidden,false);
  assert.equal(element('stage').classList.contains('is-group-calling'),true);
  assert.equal(element('groupCallList').childElementCount,2);
  data.activeCalls.push(call('three'));
  await poll();
  assert.equal(element('groupCallList').childElementCount,3);
  assert.equal(plays,1);
  data = {...data,active:null,activeCalls:[]};
  await poll();
  assert.equal(element('groupCalling').hidden,true);
  assert.equal(element('stage').classList.contains('is-group-calling'),false);
  data = {...data,active:call('next','next'),activeCalls:[call('next','next')]};
  await poll();
  assert.equal(element('callingMessage').hidden,false);
  assert.equal(element('groupCalling').hidden,true);
  assert.equal(plays,2);
});
