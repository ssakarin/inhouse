"use strict";
const DURATION=20000;
const GROUP_DURATION=35000;
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
 const fresh=calls.filter(c=>c.createdAt>now-1800000&&matches(c,beds));
 const safe=(c,forSpeech=false)=>({...(forSpeech?{speechName:c.patientName}:{}),id:c.id,groupId:c.groupId||c.id,maskedName:maskName(c.patientName),bedNo:c.bedNo,bedLabel:c.bedNo>=101?'원장실'+(c.bedNo-100):c.bedNo===15?'스파인':c.bedNo+'번 베드',startAt:c.startAt,endAt:c.endAt});
 const active=fresh.find(c=>c.startAt<=now&&c.endAt>now);
 const activeCalls=active?fresh.filter(c=>(c.groupId||c.id)===(active.groupId||active.id)).map(c=>safe(c,true)):[];
 return {serverTime:now,waitingCount:waiting.size,consultationWaitingCount:consultation.size,active:active?safe(active,true):null,activeCalls,recent:fresh.filter(c=>c.startAt<=now).slice(-3).reverse().map(c=>safe(c))};
}
function enqueue(calls,bedNo,bed,now,id){
 let fresh=calls.filter(c=>c.createdAt>now-1800000).slice(-99);
 const groups=new Map();
 fresh.filter(c=>c.endAt>now).forEach(c=>{const key=c.groupId||c.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);});
 const group=Array.from(groups.values()).reverse().find(items=>items.length<10&&(
  now-items[0].createdAt<=3000||(items.length>1&&items[0].startAt<=now)
 ));
 let groupId=id,startAt=Math.max(now+3000,...fresh.filter(c=>c.endAt>now).map(c=>c.endAt)),endAt=startAt+DURATION;
 if(group){
  groupId=group[0].groupId||group[0].id;startAt=group[0].startAt;
  const previousEnd=group[0].endAt;endAt=Math.max(previousEnd,Math.max(startAt,now)+GROUP_DURATION);
  const extension=endAt-previousEnd;
  fresh=fresh.map(c=>(c.groupId||c.id)===groupId?{...c,groupId,endAt}:extension>0&&c.startAt>=previousEnd?{...c,startAt:c.startAt+extension,endAt:c.endAt+extension}:c);
 }
 fresh.push({id,groupId,bedNo,patientKey:bed.patientKey,patientName:bed.name,createdAt:now,startAt,endAt});return fresh;
}
function onAssignment(calls,previous,beds,now,id){
 let next=calls.filter(c=>matches(c,beds));
 Object.entries(beds).forEach(([no,b])=>{
  if(!validBed(Number(no))||!b?.patientKey||!b.name)return;
  if(previous[no]?.patientKey===b.patientKey)return;
  next=enqueue(next,Number(no),b,now,id());
 });
 return next;
}
module.exports={maskName,validBed,matches,publicStatus,enqueue,onAssignment};
