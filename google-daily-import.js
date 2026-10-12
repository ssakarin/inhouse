const metrics=require('./daily-metrics');
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
function range(start,end){if(!validDate(start)||!validDate(end)||start>end||(Date.parse(end)-Date.parse(start))/86400000>730)throw Error('가져오기 기간은 올바른 날짜로 최대 731일을 선택하세요.');}
function parse(values,title,XLSX,start,end){
 range(start,end);const norm=v=>String(v??'').replace(/\s/g,'');
 const h=values.findIndex(r=>r.some(v=>norm(v)==='일자')&&r.some(v=>norm(v)==='본인부담금'));
 if(h<0)throw Error('구글시트에서 일자·본인부담금 제목을 찾지 못했습니다.');
 const header=values[h],dc=header.findIndex(v=>norm(v)==='일자'),ac=header.findIndex(v=>norm(v)==='취합');
 if(ac<0)throw Error('구글시트에서 취합 열을 찾지 못했습니다.');
 const rows=[],warnings=[],seen=new Set();
 for(let i=h+1;i<values.length;i++){
  const r=values[i];if(String(r[ac]||'').trim().toUpperCase()!=='Y')continue;
  let date=r[dc];if(typeof date==='number'){const d=XLSX.SSF.parse_date_code(date);date=d?`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:'';}else date=String(date||'').trim().replace(/[./]/g,'-');
  if(!validDate(date)){warnings.push(`${i+1}행: 잘못된 날짜 (제외)`);continue;}
  if(date<start||date>end)continue;
  if(seen.has(date))throw Error(`${date} 합계행이 중복되어 있습니다. 원본을 확인하세요.`);seen.add(date);
  const copy=[...r];copy[dc]=date;
  try{const parsed=metrics.parseWorkbook({SheetNames:['일간데이터'],Sheets:{일간데이터:{}}},{...XLSX,utils:{...XLSX.utils,sheet_to_json:()=>[header,copy]}});warnings.push(...parsed.warnings);for(const row of parsed.rows){if(row.referrals&&!Object.keys(row.referrals).length)delete row.referrals;if(Object.keys(row).length>1)rows.push(row);}}
  catch(e){warnings.push(`${date} (${i+1}행): ${e.message} (해당 날짜 제외)`);}
 }
 if(!rows.length)throw Error('선택 기간에 가져올 수 있는 합계행 자료가 없습니다.');
 return {rows:metrics.validate(rows),warnings,worksheetTitle:title};
}
function merge(previous,row){return {...previous,...row,...(row.referrals?{referrals:{...(previous?.referrals||{}),...row.referrals}}:{})};}
function preview(rows,existing){const index=new Map(existing.map(r=>[r.date,r]));return rows.map(row=>{const old=index.get(row.date)||{},changes=[];for(const key of metrics.fields)if(Object.hasOwn(row,key)&&old[key]!==row[key])changes.push({key,before:old[key]??null,after:row[key]});for(const [key,value] of Object.entries(row.referrals||{}))if(old.referrals?.[key]!==value)changes.push({key:'유입경로: '+key,before:old.referrals?.[key]??null,after:value});return {date:row.date,isNew:!index.has(row.date),changes};});}
module.exports={range,parse,merge,preview};
