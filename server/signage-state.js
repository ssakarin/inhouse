"use strict";
const DURATION=10000;
function maskName(name){const chars=Array.from(String(name||'').trim());return chars.length>1?chars.slice(0,-1).join('')+'＊':'＊';}
function validBed(no){return Number.isInteger(no)&&((no>=1&&no<=15&&no!==7)||(no>=101&&no<=110));}
function matches(c,beds){const b=beds[String(c.bedNo)];return b&&b.patientKey===c.patientKey&&b.name===c.patientName&&!b.signageArrivedAt;}
function publicStatus(patients={},beds={},alerts={},calls=[],now=Date.now()){
 const assigned=new Set(Object.values(beds).filter(Boolean).map(b=>b.patientKey));
 const waiting=new Set(),consultation=new Set();
 Object.entries(patients).forEach(([key,p])=>{
  if(!p?.name||p.bedStatus==='discharged'||assigned.has(key))return;
  const needsConsultation=p.treatments?.[0]==='진찰';
  (needsConsultation?consultation:waiting).add(key);
 });
 Object.entries(beds).forEach(([no,b])=>{if(b?.name&&b.patientKey&&Number(no)>=901&&Number(no)<=920)(b.treatments?.[0]==='진찰'?consultation:waiting).add(b.patientKey);});
 consultation.forEach(key=>waiting.delete(key));
 const fresh=calls.filter(c=>!c.pending&&c.createdAt>now-1800000&&matches(c,beds));
 const safe=(c,forSpeech=false)=>({displayName:c.patientName,...(forSpeech?{speechName:c.patientName}:{}),id:c.id,groupId:c.groupId||c.id,maskedName:maskName(c.patientName),bedNo:c.bedNo,bedLabel:c.bedNo>=101?'진료실'+(c.bedNo-100):c.bedNo===15?'스파인':c.bedNo+'번 베드',startAt:c.startAt,endAt:c.endAt});
 const active=fresh.find(c=>c.startAt<=now&&c.endAt>now);
 const activeCalls=active?[safe(active,true)]:[];
 return {serverTime:now,waitingCount:waiting.size,consultationWaitingCount:consultation.size,active:active?safe(active,true):null,activeCalls,recent:fresh.filter(c=>c.startAt<=now).slice(-3).reverse().map(c=>safe(c))};
}
function enqueue(calls,bedNo,bed,now,id,delay=3000){
 let fresh=calls.filter(c=>c.pending||c.createdAt>now-1800000).slice(-99);
 const groupId=id,startAt=Math.max(now+delay,...fresh.filter(c=>!c.pending&&c.endAt>now).map(c=>c.endAt)),endAt=startAt+DURATION;
 fresh.push({id,groupId,bedNo,patientKey:bed.patientKey,patientName:bed.name,createdAt:now,startAt,endAt});return fresh;
}
function onAssignment(calls,previous,beds,now,id){
 let next=calls.filter(c=>matches(c,beds));
 // Patients already in a treatment bed or doctor room are moving internally.
 const alreadyInside=new Set(Object.entries(previous).filter(([no,b])=>b?.patientKey&&!(Number(no)>=901&&Number(no)<=920)).map(([,b])=>b.patientKey));
 Object.entries(beds).forEach(([no,b])=>{
  if(!validBed(Number(no))||!b?.patientKey||!b.name)return;
  if(previous[no]?.patientKey===b.patientKey)return;
  if(alreadyInside.has(b.patientKey))return;
  next.push({id:id(),bedNo:Number(no),patientKey:b.patientKey,patientName:b.name,createdAt:now,pending:true});
 });
 return next;
}
function onConfirmation(calls,beds,alert,now,id){
 const no=Number(alert?.bedNo),bed=beds[String(no)];
 const pending=calls.find(c=>c.pending&&c.bedNo===no&&c.patientKey===alert?.patientKey&&matches(c,beds));
 if(!pending||!validBed(no))return calls;
 return enqueue(calls.filter(c=>c!==pending),no,bed,now,id(),0);
}
module.exports={maskName,validBed,matches,publicStatus,enqueue,onAssignment,onConfirmation};
