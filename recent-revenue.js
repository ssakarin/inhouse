(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RecentRevenue=api;})(globalThis,function(){
 const money=['insuredCopay','claimAmount','nonCoveredAmount','autoAmount'],fields=[...money,'patients','newPatients'];
 const iso=d=>d.toISOString().slice(0,10),date=s=>new Date(s+'T12:00:00Z');
 function months(today){let d=date(today);d.setUTCDate(1);return [-2,-1,0].map(n=>{let x=new Date(d);x.setUTCMonth(x.getUTCMonth()+n);return iso(x).slice(0,7);});}
 function schedule(month,closed=[],opened=[]){let ds=[];for(let d=date(month+'-01');iso(d).startsWith(month);d.setUTCDate(d.getUTCDate()+1)){let s=iso(d);if(opened.includes(s)||d.getUTCDay()!==0&&!closed.includes(s))ds.push(s);}return ds;}
 function total(rows){let r={days:rows.length,newMissing:rows.filter(r=>r.newPatients===null).length};for(let k of fields)r[k]=rows.reduce((s,r)=>s+(r[k]??0),0);r.revenue=money.reduce((s,k)=>s+r[k],0);return r;}
 const nonCoveredGroups = ['한약', '경옥고·공진단', '약침', '기타', '상세 미등록'];
 function nonCoveredDetail(rows) {
   const amounts = Object.fromEntries(nonCoveredGroups.map(group => [group, 0]));
   let total = 0;
   let detailedDays = 0;
   for (const row of rows) {
     const dailyTotal = row.nonCoveredAmount ?? 0;
     const entries = Object.entries(row.nonCoveredBreakdown || {});
     const detailedAmount = entries.reduce((sum, [, amount]) => sum + amount, 0);
     total += dailyTotal;
     if (detailedAmount > dailyTotal + 0.01) {
       amounts['상세 미등록'] += dailyTotal;
       continue;
     }
     if (entries.length) detailedDays++;
     for (const [label, amount] of entries) {
       const group = /경옥고|공진단/.test(label) ? '경옥고·공진단'
         : /약침/.test(label) ? '약침' : /한약/.test(label) ? '한약' : '기타';
       amounts[group] += amount;
     }
     amounts['상세 미등록'] += dailyTotal - detailedAmount;
   }
   return { amounts, total, days: rows.length, detailedDays };
 }

 function compareNonCovered(daily, months, today, excluded = []) {
   const currentMonth = today.slice(0, 7);
   const completed = daily.filter(row => row.date.startsWith(currentMonth)
     && row.boardVisits > 0 && row.date < today && row.revenue > 0 && !excluded.includes(row.date));
   return months.map(month => [2, 1, 0].map(back => {
     const key = `${Number(month.slice(0, 4)) - back}${month.slice(4)}`;
     let rows = daily.filter(row => row.date.startsWith(key) && row.boardVisits > 0);
     if (month === currentMonth) {
       rows = back === 0 ? completed
         : rows.sort((a, b) => a.date.localeCompare(b.date)).slice(0, completed.length);
     }
     return { month: key, ...nonCoveredDetail(rows) };
   }));
 }
 function build(daily,today,closed,opened,excluded=[]){const ms=months(today),current=ms[2],result=[];for(let m of ms)for(let back of [2,1,0]){let key=(Number(m.slice(0,4))-back)+m.slice(4),ds=daily.filter(r=>r.date.startsWith(key)&&r.boardVisits>0),r={month:key,...total(ds)};if(key===current){const complete=ds.filter(r=>r.date<today&&!excluded.includes(r.date)&&r.revenue>0),pending=ds.filter(r=>r.date<today&&(excluded.includes(r.date)||r.revenue===0));r.actual=total(complete);r.excluded=pending.map(r=>r.date);r.forecast=true;const planned=schedule(current,closed,opened),prior=daily.filter(r=>r.date.startsWith(ms[1])&&r.boardVisits>0&&r.revenue>0);r.days=planned.length;r.completed=complete.length;r.newMissing=r.actual.newMissing;r.forecastMissing=[];
 for(let k of fields){const usable=complete.filter(r=>r[k]!==null),sum=usable.reduce((s,r)=>s+r[k],0);if(!usable.length){r[k]=null;r.forecastMissing.push(k);continue;}const averages=arr=>arr.length?arr.reduce((s,r)=>s+(r[k]??0),0)/arr.length:null;const wd=averages(usable.filter(r=>date(r.date).getUTCDay()!==6)),sat=averages(usable.filter(r=>date(r.date).getUTCDay()===6)),pw=averages(prior.filter(r=>date(r.date).getUTCDay()!==6&&r[k]!==null)),ps=averages(prior.filter(r=>date(r.date).getUTCDay()===6&&r[k]!==null));const ratio=pw>0&&ps!==null?ps/pw:1,base=sum/usable.length;r[k]=planned.reduce((s,d)=>s+(date(d).getUTCDay()===6?(sat??(wd!==null?wd*ratio:base)):(wd??(sat!==null&&ratio>0?sat/ratio:base))),0);}
 r.revenue=money.some(k=>r[k]===null)?null:money.reduce((s,k)=>s+r[k],0);}result.push(r);}return result;}
 return {money,fields,months,schedule,total,build,nonCoveredGroups,compareNonCovered};
});
