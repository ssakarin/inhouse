const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const signage=require('./signage-state');
const now=2000000000,bed={patientKey:'p1',name:'김민석'};
test('one thousand simultaneous duplicate confirmations write and broadcast only once',async()=>{
 const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
 const block=source.slice(source.indexOf('  const childMatch = pathname.match'),source.indexOf('  if (pathname === "/api/discharged-patients/cleanup"'));
 const beds={101:bed};let id=0,writes=0,broadcasts=0;
 const state={bedAssignmentAlerts:{one:{bedNo:101,patientKey:'p1'}},signageCalls:signage.onAssignment([],{},beds,now,()=>String(++id))};
 const ctx=vm.createContext({
  signageState:signage,Date,crypto:{randomUUID:()=>String(++id)},
  readJson:async req=>req.body,normalizeStateKey:key=>key,getStateValue:key=>state[key],getBedsState:()=>beds,
  setStateValue:(key,value)=>{state[key]=value;writes++;},stateEquals:(a,b)=>JSON.stringify(a)===JSON.stringify(b),
  sseBroadcastStateChild:()=>broadcasts++,jsonResponse:()=>{},assertValidChartNoRecord:()=>{}
 });
 vm.runInContext('async function handle(req,res,pathname){'+block+'}',ctx);
 await Promise.all(Array.from({length:1000},()=>ctx.handle({method:'POST',body:{key:'bedAssignmentAlerts',childKey:'one',confirmed:true}},{},'/api/state-child/delete')));
 assert.equal(writes,2);assert.equal(broadcasts,1);assert.equal(state.signageCalls.length,1);assert.equal(state.signageCalls[0].pending,undefined);
 // Automatic cleanup deletes the alert but never starts a signage call.
 state.bedAssignmentAlerts={two:{bedNo:101,patientKey:'p1'}};
 state.signageCalls=signage.onAssignment([],{},beds,now,()=>String(++id));
 await ctx.handle({method:'POST',body:{key:'bedAssignmentAlerts',childKey:'two'}},{},'/api/state-child/delete');
 assert.equal(state.signageCalls[0].pending,true);
});
test('one thousand treatment updates do not rewrite or broadcast unchanged signage calls',()=>{
 const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
 const code=source.slice(source.indexOf('function commitBeds('),source.indexOf('async function handleApi('));
 const state={beds:{8:{...bed}},signageCalls:signage.enqueue([],8,bed,Date.now(),'existing'),__bedsVersion:0};
 let callWrites=0,broadcasts=0,id=0;
 const ctx=vm.createContext({
  signageState:signage,crypto:{randomUUID:()=>String(++id)},
  cloneJson:value=>JSON.parse(JSON.stringify(value)),getBedsState:()=>state.beds,
  stampBedStageTimes:(previous,next)=>next,getStateValue:key=>state[key],
  setStateValue:(key,value)=>{state[key]=value;if(key==='signageCalls')callWrites++;},
  stateEquals:(a,b)=>JSON.stringify(a)===JSON.stringify(b),getBedsVersion:()=>state.__bedsVersion,
  diffBeds:()=>({updates:[],removes:[]}),sseBroadcastBedsDelta:()=>broadcasts++
 });
 vm.runInContext(code,ctx);
 for(let i=0;i<1000;i++)ctx.commitBeds({8:{...bed,remaining:1000-i}});
 assert.equal(callWrites,0);assert.equal(id,0);assert.equal(broadcasts,1000);
 ctx.commitBeds({8:{patientKey:'new',name:'새환자'}});
 assert.equal(callWrites,1);assert.equal(id,1);
 ctx.commitBeds({8:{patientKey:'new',name:'새환자',remaining:300}});
 assert.equal(callWrites,1);
});
test('public payload includes full display names and excludes patient identifiers',()=>{
 const calls=signage.enqueue([],8,bed,now,'one');
 const out=signage.publicStatus({p1:bed,p2:{name:'대기환자'},p3:{name:'퇴실',bedStatus:'discharged'}},{8:bed},{a:{bedNo:8,patientKey:'p1'}},calls,now+3000);
 assert.equal(out.waitingCount,1);assert.equal(out.active.maskedName,'김민＊');assert.equal(out.active.bedLabel,'8번 베드');
 assert.equal(out.active.displayName,'김민석');assert.equal(out.activeCalls[0].displayName,'김민석');assert.equal(out.recent[0].displayName,'김민석');assert.equal(out.active.speechName,'김민석');assert.equal(out.activeCalls[0].speechName,'김민석');assert.ok(!JSON.stringify(out).includes('patientKey'));assert.ok(!JSON.stringify(out).includes('대기환자'));
});
test('single call waits three seconds to collect assignments and displays for ten seconds',()=>{
 const calls=signage.enqueue([],8,bed,now,'one');
 assert.equal(signage.publicStatus({}, {8:bed},{},calls,now+2999).active,null);
 assert.equal(signage.publicStatus({}, {8:bed},{},calls,now+3000).active.id,'one');
 assert.equal(signage.publicStatus({}, {8:bed},{},calls,now+12999).active.id,'one');
 const expired=signage.publicStatus({}, {8:bed},{},calls,now+13000);assert.equal(expired.active,null);assert.equal(expired.recent.length,1);
});
test('arrival and bed reassignment suppress obsolete calls and wait counts',()=>{
 const calls=signage.enqueue([],8,bed,now,'one');
 assert.equal(signage.publicStatus({}, {8:{...bed,signageArrivedAt:now}},{a:{bedNo:8,patientKey:'p1'}},calls,now).waitingCount,0);
 assert.equal(signage.publicStatus({}, {8:{...bed,patientKey:'new'}},{},calls,now).active,null);
 assert.equal(signage.publicStatus({p1:bed},{901:bed},{},[],now).waitingCount,1);
 assert.equal(signage.validBed(7),false);assert.equal(signage.validBed(101),true);assert.equal(signage.validBed(901),false);
});
test('assignment automatically calls once and ignores edits and non-treatment beds',()=>{
 let serial=0;const id=()=>String(++serial);
 let calls=signage.onAssignment([],{}, {8:bed,901:{patientKey:'held',name:'대기'}},now,id);
 assert.equal(calls.length,1);
 calls=signage.onAssignment(calls,{8:bed},{8:{...bed,memo:'수정'}},now+100,id);
 assert.equal(calls.length,1);
 calls=signage.onAssignment(calls,{8:bed},{8:{patientKey:'p2',name:'이환자'}},now+200,id);
 assert.equal(calls.length,1);assert.equal(calls[0].patientKey,'p2');
});
test('consultation and treatment queues are separate and exclude discharged and examining patients',()=>{
 const patients={initial:{name:'초진',visitType:'초진'},exam:{name:'진찰',treatments:['진찰']},regular:{name:'재진'},gone:{name:'퇴실',visitType:'초진',bedStatus:'discharged'},inRoom:{name:'진찰중',visitType:'초진'}};
 const beds={101:{patientKey:'inRoom',name:'진찰중'},901:{patientKey:'heldExam',name:'진찰대기',treatments:['진찰'],pendingTargetBedNo:101},902:{patientKey:'heldTreat',name:'치료대기',pendingTargetBedNo:15},8:{...bed}};
 const out=signage.publicStatus(patients,beds,{a:{bedNo:8,patientKey:'p1'}},[],now);
 assert.equal(out.consultationWaitingCount,2);assert.equal(out.waitingCount,3);
});
test('only waiting room arrivals call, including swaps and doctor room transfers',()=>{
 let serial=0;const id=()=>String(++serial);
 for(const [from,to] of [[1,8],[101,8],[8,101],[101,102],[7,8],[15,8]]){
  const existing=signage.enqueue([],from,bed,now,'old');
  assert.equal(signage.onAssignment(existing,{[from]:bed},{[to]:bed},now+100,id).length,0);
 }
 const other={patientKey:'p2',name:'이환자'};
 assert.equal(signage.onAssignment([],{1:bed,8:other},{1:other,8:bed},now,id).length,0);
 for(const target of [8,15,101]){
  assert.equal(signage.onAssignment([],{901:bed},{[target]:bed},now,id).length,1);
  assert.equal(signage.onAssignment([],{}, {[target]:bed},now,id).length,1);
 }
 const calls=signage.onAssignment([],{1:bed,901:other},{8:bed,9:other},now,id);
 assert.equal(calls.length,1);assert.equal(calls[0].patientKey,'p2');
});

test('doctor room assignments are sequential with room labels and no repeat on edits',()=>{
 const beds={101:{patientKey:'d1',name:'김환자'},102:{patientKey:'d2',name:'이환자'}};let serial=0;
 let calls=signage.onAssignment([],{},beds,now,()=>String(++serial));
 assert.equal(calls.length,2);
 assert.equal(signage.publicStatus({},beds,{},calls,now+3000).active,null);
 for(const call of [...calls])calls=signage.onConfirmation(calls,beds,call,now+3000,()=>String(++serial));
 assert.equal(signage.publicStatus({},beds,{},calls,now+3000).active.bedLabel,'진료실1');
 assert.equal(signage.publicStatus({},beds,{},calls,now+13000).active.bedLabel,'진료실2');
 assert.equal(signage.onAssignment(calls,beds,{...beds,101:{...beds[101],memo:'수정'}},now+100,()=>String(++serial)).length,2);
 const held={901:beds[101]};const moved=signage.onAssignment([],held,{101:beds[101]},now,()=>String(++serial));assert.equal(moved.length,1);assert.equal(moved[0].bedNo,101);
});

test('ten simultaneous arrivals display individually for ten seconds in order',()=>{
 const beds={};for(let i=1;i<=6;i++)beds[i]={patientKey:'p'+i,name:'patient'+i};for(let i=8;i<=11;i++)beds[i]={patientKey:'p'+i,name:'patient'+i};
 let id=0;let calls=signage.onAssignment([],{},beds,now,()=>String(++id));
 for(const call of [...calls])calls=signage.onConfirmation(calls,beds,call,now,()=>String(++id));
 assert.equal(new Set(calls.map(c=>c.groupId)).size,10);
 for(let i=0;i<10;i++){
  const out=signage.publicStatus({},beds,{},calls,now+i*10000);
  assert.equal(out.active.id,calls[i].id);assert.equal(out.activeCalls.length,1);
  assert.equal(out.active.endAt-out.active.startAt,10000);
 }
 const expanded={...beds,12:{patientKey:'new',name:'new patient'}};
 calls=signage.onAssignment(calls,beds,expanded,now+5000,()=>String(++id));
 calls=signage.onConfirmation(calls,expanded,{bedNo:12,patientKey:'new'},now+5000,()=>String(++id));
 assert.equal(calls.at(-1).startAt,now+100000);
 assert.equal(signage.publicStatus({},expanded,{},calls,now+110000).active,null);
});

test('assignments outside the collection window do not join an active single call',()=>{
 const beds={8:bed};let id=0;let calls=signage.onAssignment([],{},beds,now,()=>String(++id));
 calls=signage.onConfirmation(calls,beds,{bedNo:8,patientKey:bed.patientKey},now,()=>String(++id));
 const expanded={...beds,9:{patientKey:'p2',name:'이환자'}};
 calls=signage.onAssignment(calls,beds,expanded,now+4000,()=>String(++id));
 calls=signage.onConfirmation(calls,expanded,{bedNo:9,patientKey:'p2'},now+4000,()=>String(++id));
 assert.notEqual(calls[0].groupId,calls[1].groupId);assert.equal(calls[1].startAt,calls[0].endAt);
});
test('bed assignment stays silent until confirmed, confirms once and ignores stale confirmations',()=>{
 let serial=0;const id=()=>String(++serial),beds={8:bed};
 const pending=signage.onAssignment([],{},beds,now,id);
 assert.equal(pending[0].pending,true);
 assert.equal(signage.publicStatus({},beds,{},pending,now+5000).active,null);
 const called=signage.onConfirmation(pending,beds,{bedNo:8,patientKey:'p1'},now+5000,id);
 assert.equal(called.length,1);assert.equal(called[0].startAt,now+5000);
 assert.equal(signage.publicStatus({},beds,{},called,now+8000).activeCalls.length,1);
 assert.deepEqual(signage.onConfirmation(called,beds,{bedNo:8,patientKey:'p1'},now+6000,id),called);
 assert.deepEqual(signage.onConfirmation(pending,{8:{patientKey:'new',name:'다른환자'}},{bedNo:8,patientKey:'p1'},now+5000,id),pending);
 const moved=signage.onAssignment(pending,beds,{9:bed},now+1000,id);
 assert.equal(moved.length,0);
 assert.equal(signage.onConfirmation(moved,{9:bed},{bedNo:9,patientKey:'p1'},now+5000,id).length,0);
});

test('waiting room classification depends only on first treatment and ignores assignment alerts',()=>{
 const patients={a:{name:'재진진찰',visitType:'재진',treatments:['진찰','핫팩']},b:{name:'초진치료',visitType:'초진',treatments:['핫팩','진찰']},c:{name:'미선택',treatments:[]},d:{name:'베드배정',treatments:['진찰']},e:{name:'진료실배정',treatments:['진찰']}};
 const beds={8:{patientKey:'d',name:'베드배정'},101:{patientKey:'e',name:'진료실배정'},901:{patientKey:'held',name:'대기',treatments:['핫팩'],pendingTargetBedNo:101}};
 const alerts={d:{bedNo:8,patientKey:'d'},e:{bedNo:101,patientKey:'e'}};
 const out=signage.publicStatus(patients,beds,alerts,[],now);
 assert.equal(out.consultationWaitingCount,1);assert.equal(out.waitingCount,3);
});
