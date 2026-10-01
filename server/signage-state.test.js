const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const signage=require('./signage-state');
const now=2000000000,bed={patientKey:'p1',name:'김민석'};
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
test('public payload masks name and excludes patient identifiers',()=>{
 const calls=signage.enqueue([],8,bed,now,'one');
 const out=signage.publicStatus({p1:bed,p2:{name:'대기환자'},p3:{name:'퇴실',bedStatus:'discharged'}},{8:bed},{a:{bedNo:8,patientKey:'p1'}},calls,now+3000);
 assert.equal(out.waitingCount,1);assert.equal(out.active.maskedName,'김민＊');assert.equal(out.active.bedLabel,'8번 베드');
 assert.equal(out.active.speechName,'김민석');assert.equal(out.activeCalls[0].speechName,'김민석');assert.ok(!JSON.stringify(out.recent).includes('김민석'));assert.ok(!JSON.stringify(out).includes('patientKey'));assert.ok(!JSON.stringify(out).includes('대기환자'));
});
test('single call waits three seconds to collect assignments and displays for twenty seconds',()=>{
 const calls=signage.enqueue([],8,bed,now,'one');
 assert.equal(signage.publicStatus({}, {8:bed},{},calls,now+2999).active,null);
 assert.equal(signage.publicStatus({}, {8:bed},{},calls,now+3000).active.id,'one');
 assert.equal(signage.publicStatus({}, {8:bed},{},calls,now+22999).active.id,'one');
 const expired=signage.publicStatus({}, {8:bed},{},calls,now+23000);assert.equal(expired.active,null);assert.equal(expired.recent.length,1);
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

test('doctor room assignments are grouped with room labels and no repeat on edits',()=>{
 const beds={101:{patientKey:'d1',name:'김환자'},102:{patientKey:'d2',name:'이환자'}};let serial=0;
 const calls=signage.onAssignment([],{},beds,now,()=>String(++serial));
 assert.equal(calls.length,2);
 assert.equal(signage.publicStatus({},beds,{},calls,now+3000).active.bedLabel,'원장실1');
 assert.equal(signage.publicStatus({},beds,{},calls,now+3000).activeCalls[1].bedLabel,'원장실2');
 assert.equal(signage.onAssignment(calls,beds,{...beds,101:{...beds[101],memo:'수정'}},now+100,()=>String(++serial)).length,2);
 const held={901:beds[101]};const moved=signage.onAssignment([],held,{101:beds[101]},now,()=>String(++serial));assert.equal(moved.length,1);assert.equal(moved[0].bedNo,101);
});

test('ten simultaneous assignments share a call group and extend from the last added patient',()=>{
 const beds={};for(let i=1;i<=6;i++)beds[i]={patientKey:'p'+i,name:'환자'+i};for(let i=8;i<=11;i++)beds[i]={patientKey:'p'+i,name:'환자'+i};
 let id=0;let calls=signage.onAssignment([],{},beds,now,()=>String(++id));
 let out=signage.publicStatus({},beds,{},calls,now+3000);
 assert.equal(out.activeCalls.length,10);assert.equal(out.active.endAt,now+38000);assert.equal(new Set(out.activeCalls.map(c=>c.groupId)).size,1);
 assert.ok(!JSON.stringify(out).includes('patientKey'));
 const expanded={...beds,12:{patientKey:'p12',name:'추가환자'}};
 calls=signage.onAssignment(calls,beds,expanded,now+5000,()=>String(++id));
 assert.equal(signage.publicStatus({},expanded,{},calls,now+5000).activeCalls.length,10);
 assert.equal(signage.publicStatus({},expanded,{},calls,now+38000).activeCalls.length,1);
});
test('active batch accepts new patients without a new group and remains thirty-five seconds after addition',()=>{
 const beds={8:bed,9:{patientKey:'p2',name:'이환자'}};let id=0;
 let calls=signage.onAssignment([],{},beds,now,()=>String(++id));
 const expanded={...beds,10:{patientKey:'p3',name:'박환자'}};
 calls=signage.onAssignment(calls,beds,expanded,now+10000,()=>String(++id));
 const out=signage.publicStatus({},expanded,{},calls,now+10000);
 assert.equal(out.activeCalls.length,3);assert.equal(new Set(out.activeCalls.map(c=>c.groupId)).size,1);
 assert.equal(out.active.endAt,now+45000);
 assert.equal(signage.publicStatus({},expanded,{},calls,now+45000).active,null);
});
test('assignments outside the collection window do not join an active single call',()=>{
 const beds={8:bed};let id=0;let calls=signage.onAssignment([],{},beds,now,()=>String(++id));
 const expanded={...beds,9:{patientKey:'p2',name:'이환자'}};
 calls=signage.onAssignment(calls,beds,expanded,now+4000,()=>String(++id));
 assert.notEqual(calls[0].groupId,calls[1].groupId);assert.equal(calls[1].startAt,calls[0].endAt);
});

test('waiting room classification depends only on first treatment and ignores assignment alerts',()=>{
 const patients={a:{name:'재진진찰',visitType:'재진',treatments:['진찰','핫팩']},b:{name:'초진치료',visitType:'초진',treatments:['핫팩','진찰']},c:{name:'미선택',treatments:[]},d:{name:'베드배정',treatments:['진찰']},e:{name:'원장실배정',treatments:['진찰']}};
 const beds={8:{patientKey:'d',name:'베드배정'},101:{patientKey:'e',name:'원장실배정'},901:{patientKey:'held',name:'대기',treatments:['핫팩'],pendingTargetBedNo:101}};
 const alerts={d:{bedNo:8,patientKey:'d'},e:{bedNo:101,patientKey:'e'}};
 const out=signage.publicStatus(patients,beds,alerts,[],now);
 assert.equal(out.consultationWaitingCount,1);assert.equal(out.waitingCount,3);
});
