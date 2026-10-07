(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ClinicDailyMetrics=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const fields=['insuredCopay','claimAmount','nonCoveredAmount','autoAmount','appointmentCount','attendedCount','noShowCount','cancelledCount'];
  const norm=s=>String(s||'').replace(/\s/g,'');
  function validate(rows){
    if(!Array.isArray(rows)||!rows.length||rows.length>5000)throw Error('일별 자료는 1~5000일이어야 합니다.');
    const seen=new Set();
    return rows.map(row=>{
      const date=String(row.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date||seen.has(date))throw Error('잘못되거나 중복된 날짜: '+date);seen.add(date);
      const result={date};
      for(const k of fields){const v=row[k];if(v===null||v===undefined||v==='')continue;if(typeof v!=='number'||!Number.isFinite(v)||v<0||(k.endsWith('Count')&&!Number.isInteger(v)))throw Error(date+' '+k+' 값 오류');result[k]=v;}
      if(row.referrals){result.referrals={};for(const[k,v]of Object.entries(row.referrals)){if(!k.trim()||k.length>50||typeof v!=='number'||!Number.isInteger(v)||v<0)throw Error(date+' 유입경로 값 오류');result.referrals[k.trim()]=v;}}
      return result;
    });
  }
  function parseWorkbook(wb,XLSX){
    const name=wb.SheetNames.includes('일간데이터')?'일간데이터':wb.SheetNames.includes('Raw Data')?'Raw Data':null;if(!name)throw Error('일간데이터 또는 Raw Data 시트가 필요합니다.');
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:null});
    const h=rows.findIndex(r=>r.some(v=>norm(v)==='본인부담금')&&r.some(v=>norm(v)==='일자'));if(h<0)throw Error('일별 항목 제목을 찾지 못했습니다.');
    const header=rows[h].map(norm);const col=label=>header.indexOf(norm(label));const map={insuredCopay:'본인부담금',claimAmount:'공단청구금',nonCoveredAmount:'비급여매출',autoAmount:'자보매출',appointmentCount:'오늘예약된환자수',attendedCount:'예약정상이행',noShowCount:'예약노쇼',cancelledCount:'예약취소'};
    const dateCol=col('일자'),aggregate=col('취합');const start=col('간판');const end=col('금액_최초결제')>=0?col('금액_최초결제'):header.findIndex((v,i)=>i>start&&v==='녹용한약');
    const number=v=>v===null||v===undefined||String(v).trim()===''||String(v).trim()==='-'?undefined:typeof v==='number'?v:Number(String(v).replace(/,/g,''));
    const result=[];
    for(const r of rows.slice(h+1)){
      if(aggregate>=0&&String(r[aggregate]||'').toUpperCase()!=='Y')continue;
      const raw=r[dateCol];let date='';if(typeof raw==='number'){const d=XLSX.SSF.parse_date_code(raw);if(d)date=`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}else if(raw instanceof Date)date=raw.toISOString().slice(0,10);else date=String(raw||'').trim().replace(/[./]/g,'-').slice(0,10);
      if(!date)continue;const out={date};for(const[k,label]of Object.entries(map)){const i=col(label);if(i>=0){const value=number(r[i]);if(value!==undefined)out[k]=value;}}
      if(start>=0){out.referrals={};for(let i=start;i<(end>start?end:start+9);i++){const value=number(r[i]);if(value!==undefined&&header[i])out.referrals[String(rows[h][i]).trim()]=value;}}
      if(Object.keys(out).length>1)result.push(out);
    }
    return {sheet:name,rows:validate(result)};
  }
  function overlay(base,imports,board,periodKey){
    if(!imports.length)return base;
    const days=new Map(board.map(r=>[r.date,{...r}]));const importedDays=new Set();
    for(const row of imports){const previous=days.get(row.date)||{date:row.date,totalFee:0,insuredCopay:0,claimAmount:0,nonCoveredAmount:0,autoAmount:0,visits:0};const next={...previous};let financial=false;for(const k of fields.slice(0,4))if(Object.hasOwn(row,k)){next[k]=row[k];financial=true;}if(financial){next.totalFee=(next.insuredCopay||0)+(next.claimAmount||0)+(next.autoAmount||0);importedDays.add(row.date);}days.set(row.date,next);}
    const totals={totalFee:0,insuredCopay:0,claimAmount:0,nonCoveredAmount:0,autoAmount:0};const buckets=new Map();const financeDays=new Set();
    for(const row of days.values()){const key=periodKey(row.date);if(!buckets.has(key))buckets.set(key,{key,totalFee:0,insuredCopay:0,claimAmount:0,nonCoveredAmount:0,autoAmount:0,dates:new Set(),coveredVisits:0});const bucket=buckets.get(key);for(const k of Object.keys(totals)){totals[k]+=Number(row[k]||0);bucket[k]+=Number(row[k]||0);}if(row.visits||row.totalFee||row.nonCoveredAmount){financeDays.add(row.date);bucket.dates.add(row.date);}bucket.coveredVisits+=Number(row.visits||0);}
    const operational={};for(const k of fields.slice(4)){const matching=imports.filter(r=>Object.hasOwn(r,k));operational[k]={value:matching.reduce((s,r)=>s+r[k],0),days:matching.length};}
    const referrals={};for(const row of imports)for(const[k,v]of Object.entries(row.referrals||{}))referrals[k]=(referrals[k]||0)+v;
    const source={importedDays:importedDays.size,financeDays:financeDays.size,rows:imports,operational,referrals};
    if(!importedDays.size)return {...base,dailyMetrics:source};
    const trends=new Map((base.trendStats||[]).map(r=>[r.key,{...r}]));for(const[key,b]of buckets){const trend=trends.get(key)||{key,clinicDays:b.dates.size};Object.assign(trend,{avgCombinedFeePerDay:(b.totalFee+b.nonCoveredAmount)/Math.max(1,b.dates.size),avgTotalFeePerDay:b.totalFee/Math.max(1,b.dates.size),avgNonCoveredFeePerDay:b.nonCoveredAmount/Math.max(1,b.dates.size),avgCombinedFeePerVisit:null,financialAggregate:true});trends.set(key,trend);}
    return {...base,financialTotals:totals,financialTrend:[...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(({dates,...b})=>({...b,clinicDays:dates.size})),trendStats:[...trends.values()].sort((a,b)=>a.key.localeCompare(b.key)),dailyMetrics:source,financialAggregate:true};
  }
  return {fields,validate,parseWorkbook,overlay};
});
