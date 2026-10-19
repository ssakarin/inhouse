(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ClinicDailyMetrics=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const patientFields=['patientCount','newPatientCount','returnPatientCount','reinitialPatientCount'];
  const fields=['insuredCopay','claimAmount','nonCoveredAmount','autoAmount','appointmentCount','attendedCount','noShowCount','cancelledCount',...patientFields];
  const norm=s=>String(s||'').replace(/\s/g,'');
  function validate(rows){
    if(!Array.isArray(rows)||!rows.length||rows.length>5000)throw Error('일별 자료는 1~5000일이어야 합니다.');
    const seen=new Set(), mismatches=[];
    const clean=rows.map(row=>{
      const date=String(row.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date||seen.has(date))throw Error('잘못되거나 중복된 날짜: '+date);seen.add(date);
      const result={date};
      for(const k of fields){const v=row[k];if(v===null||v===undefined||v==='')continue;if(typeof v!=='number'||!Number.isFinite(v)||v<0||(k.endsWith('Count')&&!Number.isInteger(v)))throw Error(date+' '+k+' 값 오류');result[k]=v;}
      if(row.referrals){result.referrals={};for(const[k,v]of Object.entries(row.referrals)){if(!k.trim()||k.length>50||typeof v!=='number'||!Number.isInteger(v)||v<0)throw Error(date+' 유입경로 값 오류');result.referrals[k.trim()]=v;}}
      if(row.nonCoveredBreakdown){result.nonCoveredBreakdown={};for(const [k,v] of Object.entries(row.nonCoveredBreakdown)){if(!k.trim()||k.length>50||typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error(date+' 비급여 상세 값 오류');result.nonCoveredBreakdown[k.trim()]=v;}}
      if(result.nonCoveredBreakdown){
        const total=Object.values(result.nonCoveredBreakdown).reduce((sum,value)=>sum+value,0);
        if(!Object.hasOwn(result,'nonCoveredAmount'))mismatches.push(`${date}: 상세 합계 ${total.toLocaleString()}원 / 비급여매출 공란`);
        else if(Math.abs(total-result.nonCoveredAmount)>0.01)mismatches.push(`${date}: 상세 합계 ${total.toLocaleString()}원 / 비급여매출 ${result.nonCoveredAmount.toLocaleString()}원 / 차액 ${(total-result.nonCoveredAmount).toLocaleString()}원`);
      }
      return result;
    });
    if(mismatches.length)throw Error(`비급여 상세 합계와 비급여매출이 일치하지 않거나 공란인 날짜 ${mismatches.length}일 (저장 불가)\n${mismatches.join('\n')}`);
    return clean;
  }
  function parseNonCoveredDetails(rows, XLSX, allowedDates = null) {
    const h=rows.findIndex(r=>r.some(v=>norm(v)==='일자')&&r.some(v=>norm(v)==='본인부담금'));
    if(h<0)return {};
    const header=rows[h].map(norm), dc=header.indexOf('일자');
    const find=labels=>header.findIndex(v=>labels.includes(v));
    const first=find(['금액_최초결제','비급여합계']), repeat=find(['금액_재결제','비급여합계_재결제']);
    const aggregate=header.indexOf('취합');
    if(first<0&&repeat<0)return {};
    // Each payment block has its category four columns before its amount (AG/AK, AL/AP).
    const blocks=[first,repeat].filter(i=>i>=4), result={};let date='';
    for(const r of rows.slice(h+1)){
      const raw=r[dc];
      if(raw!==null&&raw!==undefined&&String(raw).trim()!==''){
        if(typeof raw==='number'){const d=XLSX.SSF.parse_date_code(raw);date=d?`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:'';}
        else date=raw instanceof Date?raw.toISOString().slice(0,10):String(raw).trim().replace(/[./]/g,'-').slice(0,10);
      }
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||(allowedDates&&!allowedDates.has(date)))continue;
      if(aggregate>=0&&String(r[aggregate]??'').trim().toUpperCase()==='Y')continue;
      for(const amountCol of blocks){
        const label=String(r[amountCol-4]??'').trim(),rawAmount=r[amountCol];
        if(!label||rawAmount===null||rawAmount===undefined||String(rawAmount).trim()===''||String(rawAmount).trim()==='-')continue;
        const amount=typeof rawAmount==='number'?rawAmount:Number(String(rawAmount).replace(/,/g,''));
        if(!Number.isFinite(amount)||amount<0)throw Error(date+' '+label+' 비급여 상세 금액 오류');
        const category=label.replace(/\s/g,'').replace(/_?재결제$/,'');
        if(!category||category==='-'||typeof r[amountCol-4]!=='string')continue;
        if(!result[date])result[date]={};
        result[date][category]=(result[date][category]||0)+amount;
      }
    }
    return result;
  }
  function parseWorkbook(wb,XLSX,options={}){
    const name=wb.SheetNames.find(n=>norm(n)==='일간데이터')|| (wb.SheetNames.includes('Raw Data')?'Raw Data':null);if(!name)throw Error('일간데이터 또는 Raw Data 시트가 필요합니다.');
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:null});
    const h=rows.findIndex(r=>r.some(v=>norm(v)==='본인부담금')&&r.some(v=>norm(v)==='일자'));if(h<0)throw Error('일별 항목 제목을 찾지 못했습니다.');
    const header=rows[h].map(norm);const col=label=>header.indexOf(norm(label));const map={insuredCopay:'본인부담금',claimAmount:'공단청구금',nonCoveredAmount:'비급여매출',autoAmount:'자보매출',appointmentCount:'오늘예약된환자수',attendedCount:'예약정상이행',noShowCount:'예약노쇼',cancelledCount:'예약취소',patientCount:'당일환자수',newPatientCount:'신규환자수',returnPatientCount:'재진환자수',reinitialPatientCount:'재초진환자수'};
    const dateCol=col('일자'),aggregate=col('취합');const start=col('간판');const end=col('금액_최초결제')>=0?col('금액_최초결제'):col('비급여')>=0?col('비급여'):header.findIndex((v,i)=>i>start&&v==='녹용한약');
    const number=v=>v===null||v===undefined||String(v).trim()===''||String(v).trim()==='-'?undefined:typeof v==='number'?v:Number(String(v).replace(/,/g,''));
    const result=[],warnings=[];
    for(const r of rows.slice(h+1)){
      if(aggregate>=0&&String(r[aggregate]||'').toUpperCase()!=='Y')continue;
      const raw=r[dateCol];let date='';if(typeof raw==='number'){const d=XLSX.SSF.parse_date_code(raw);if(d)date=`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}else if(raw instanceof Date)date=raw.toISOString().slice(0,10);else date=String(raw||'').trim().replace(/[./]/g,'-').slice(0,10);
      if(!date)continue;const out={date};for(const[k,label]of Object.entries(map)){const i=col(label);if(i>=0){const value=number(r[i]);if(value!==undefined){if(patientFields.includes(k)&&(!Number.isFinite(value)||value<0||!Number.isInteger(value))){warnings.push(`${date} ${label}: ${String(r[i])} (등록 제외)`);continue;}out[k]=value;}}}
      if(start>=0){out.referrals={};for(let i=start;i<(end>start?end:start+9);i++){const value=number(r[i]);if(value!==undefined&&header[i])out.referrals[String(rows[h][i]).trim()]=value;}}
      if(Object.keys(out).length>1)result.push(out);
    }
    const details=options.skipDetails?{}:parseNonCoveredDetails(rows,XLSX,new Set(result.map(row=>row.date)));
    for(const row of result)if(details[row.date])row.nonCoveredBreakdown=details[row.date];
    return {sheet:name,rows:validate(result),warnings};
  }
  function referralAnalysis(rows=[]){
    const recorded=rows.filter(row=>row.referrals&&Object.keys(row.referrals).length);
    const counts={};let newPatients=0,matchedNewPatientDays=0;const discrepancies=[];
    for(const row of recorded){
      let total=0;for(const [label,value] of Object.entries(row.referrals)){const key=norm(label);counts[key]=(counts[key]||0)+value;total+=value;}
      if(Object.hasOwn(row,'newPatientCount')){newPatients+=row.newPatientCount;matchedNewPatientDays++;if(total!==row.newPatientCount)discrepancies.push({date:row.date,newPatientCount:row.newPatientCount,referralCount:total});}
    }
    const total=Object.values(counts).reduce((sum,value)=>sum+value,0);
    return {days:recorded.length,total,newPatients,matchedNewPatientDays,discrepancies,channels:Object.entries(counts).map(([label,count])=>({label,count,share:total?count/total:0})).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'ko'))};
  }
  function overlay(base,imports,board,periodKey){
    if(!imports.length)return base;
    const days=new Map(board.map(r=>[r.date,{...r}]));const importedDays=new Set();const importedPatients=new Map(imports.map(r=>[r.date,r.patientCount]));
    for(const row of imports){const previous=days.get(row.date)||{date:row.date,totalFee:0,insuredCopay:0,claimAmount:0,nonCoveredAmount:0,autoAmount:0,visits:0};const next={...previous};let financial=false;next.hasCombinedFinance=previous.hasCombinedFinance??(previous.totalFee!==null&&previous.totalFee!==undefined||previous.nonCoveredAmount!==null&&previous.nonCoveredAmount!==undefined);next.hasNoncoveredFinance=previous.hasNoncoveredFinance??(previous.nonCoveredAmount!==null&&previous.nonCoveredAmount!==undefined);for(const k of fields.slice(0,4))if(Object.hasOwn(row,k)){next[k]=row[k];financial=true;next.hasCombinedFinance=true;if(k==='nonCoveredAmount')next.hasNoncoveredFinance=true;}if(financial){next.totalFee=(next.insuredCopay||0)+(next.claimAmount||0)+(next.autoAmount||0);importedDays.add(row.date);}days.set(row.date,next);}
    const totals={totalFee:0,insuredCopay:0,claimAmount:0,nonCoveredAmount:0,autoAmount:0};const buckets=new Map();const financeDays=new Set();
    for(const row of days.values()){const key=periodKey(row.date);if(!buckets.has(key))buckets.set(key,{key,totalFee:0,insuredCopay:0,claimAmount:0,nonCoveredAmount:0,autoAmount:0,dates:new Set(),coveredVisits:0,perVisitCount:0,hasCombinedFinance:false,hasNoncoveredFinance:false});const bucket=buckets.get(key);const active=Number(row.visits||0)>0||Number(row.totalFee||0)>0||Number(row.nonCoveredAmount||0)>0;if(active){bucket.hasCombinedFinance ||= row.hasCombinedFinance??(row.totalFee!=null||row.nonCoveredAmount!=null);bucket.hasNoncoveredFinance ||= row.hasNoncoveredFinance??(row.nonCoveredAmount!=null);}for(const k of Object.keys(totals)){totals[k]+=Number(row[k]||0);bucket[k]+=Number(row[k]||0);}if(row.visits||row.totalFee||row.nonCoveredAmount){financeDays.add(row.date);bucket.dates.add(row.date);}bucket.coveredVisits+=Number(row.visits||0);bucket.perVisitCount+=Number(importedPatients.get(row.date)??row.visits??0);}
    const operational={};for(const k of fields.slice(4)){const matching=imports.filter(r=>Object.hasOwn(r,k));operational[k]={value:matching.reduce((s,r)=>s+r[k],0),days:matching.length};}
    const referrals={};for(const row of imports)for(const[k,v]of Object.entries(row.referrals||{}))referrals[k]=(referrals[k]||0)+v;
    const source={importedDays:importedDays.size,financeDays:financeDays.size,rows:imports,operational,referrals,perVisitCount:[...buckets.values()].reduce((sum,b)=>sum+b.perVisitCount,0)};
    // Each patient measure uses only populated values on recorded clinic days.
    // Keep these aggregates separate from patient-level follow-up cohorts.
    const active=row=>Object.hasOwn(row,'patientCount')?row.patientCount>0:patientFields.some(k=>Number(row[k]||0)>0)||fields.slice(0,4).some(k=>Number(row[k]||0)>0);
    function patientSummary(rows){const summary={};for(const k of patientFields){const matching=rows.filter(r=>active(r)&&Object.hasOwn(r,k));const value=matching.reduce((s,r)=>s+r[k],0);summary[k]={value,days:matching.length,average:matching.length?value/matching.length:null};}return summary;}
    // Count distinct dates with visits, including imported patient records.
    const clinicDates=new Set(board.filter(row=>Number(row.visits||0)>0).map(row=>row.date));
    for(const row of imports)if(active(row))clinicDates.add(row.date);
    const clinicDatesByPeriod=new Map();
    for(const date of clinicDates){const key=periodKey(date);clinicDatesByPeriod.set(key,(clinicDatesByPeriod.get(key)||0)+1);}
    base={...base,actualClinicDays:clinicDates.size,trendStats:(base.trendStats||[]).map(row=>({...row,actualClinicDays:clinicDatesByPeriod.get(row.key)||0}))};
    source.patients=patientSummary(imports);
    function financeSummary(rows){const matching=rows.filter(r=>active(r)&&Object.hasOwn(r,'autoAmount'));const value=matching.reduce((sum,r)=>sum+r.autoAmount,0);return {autoAmount:{value,days:matching.length,average:matching.length?value/matching.length:null}};}
    source.finance=financeSummary(imports);
    const patientBuckets=new Map();for(const row of imports){const key=periodKey(row.date);if(!patientBuckets.has(key))patientBuckets.set(key,[]);patientBuckets.get(key).push(row);}
    const patientTrends=new Map((base.trendStats||[]).map(r=>[r.key,{...r}]));
    for(const [key,rows] of patientBuckets){const trend=patientTrends.get(key)||{key,clinicDays:rows.filter(active).length};trend.actualClinicDays=clinicDatesByPeriod.get(key)||0;trend.dailyPatientCounts=patientSummary(rows);trend.dailyFinanceCounts=financeSummary(rows);patientTrends.set(key,trend);}
    base={...base,trendStats:[...patientTrends.values()].sort((a,b)=>a.key.localeCompare(b.key))};
    if(!importedDays.size)return {...base,dailyMetrics:source};
    const trends=new Map((base.trendStats||[]).map(r=>[r.key,{...r}]));for(const[key,b]of buckets){const trend=trends.get(key)||{key,clinicDays:b.dates.size};Object.assign(trend,{avgCombinedFeePerDay:b.hasCombinedFinance?(b.totalFee+b.nonCoveredAmount)/Math.max(1,b.dates.size):null,avgTotalFeePerDay:b.totalFee/Math.max(1,b.dates.size),avgNonCoveredFeePerDay:b.hasNoncoveredFinance?b.nonCoveredAmount/Math.max(1,b.dates.size):null,avgCombinedFeePerVisit:b.hasCombinedFinance&&b.perVisitCount?(b.totalFee+b.nonCoveredAmount)/b.perVisitCount:null,financialAggregate:true});trends.set(key,trend);}
    return {...base,financialTotals:totals,financialTrend:[...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(({dates,...b})=>({...b,clinicDays:dates.size})),trendStats:[...trends.values()].sort((a,b)=>a.key.localeCompare(b.key)),dailyMetrics:source,financialAggregate:true};
  }
  return {fields,patientFields,validate,parseWorkbook,parseNonCoveredDetails,referralAnalysis,overlay};
});
