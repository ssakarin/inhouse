import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const file = "C:/Users/Hippo/OneDrive/바탕 화면/자료/2026년_1월1일-8월10일_진료비_비교_월별가로요약.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
const sheet = workbook.worksheets.getItem("날짜별 상세 비교");
const values = sheet.getRange("A6:AG187").values;
const metrics = [
  { name: "총 진료비", excel: 1, server: 2 },
  { name: "본인 부담금", excel: 5, server: 6 },
  { name: "공단 청구금", excel: 9, server: 10 },
  { name: "본인부담금+공단청구금", excel: 13, server: 14 },
  { name: "비급여 매출", excel: 17, server: 18 },
  { name: "자보 매출", excel: 21, server: 22 },
];

const rows = values.filter(r => /^2026-\d{2}-\d{2}$/.test(String(r[0] ?? ""))).map(r => ({
  date: String(r[0]),
  values: Object.fromEntries(metrics.map(m => [m.name, { excel: Number(r[m.excel] || 0), server: Number(r[m.server] || 0) }]))
}));

function isoWeek(dateText) {
  const d = new Date(`${dateText}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function summarizeGroups(keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row.date);
    if (!groups.has(key)) groups.set(key, { key, first: row.date, last: row.date, days: 0, totals: Object.fromEntries(metrics.map(m => [m.name, { excel: 0, server: 0 }])) });
    const g = groups.get(key); g.days++; g.last = row.date;
    for (const m of metrics) { g.totals[m.name].excel += row.values[m.name].excel; g.totals[m.name].server += row.values[m.name].server; }
  }
  return [...groups.values()].map(g => ({ ...g, totals: Object.fromEntries(metrics.map(m => { const t=g.totals[m.name], diff=t.server-t.excel; return [m.name,{...t,diff,signedPct:t.excel?diff/t.excel*100:null,absPct:t.excel?Math.abs(diff)/Math.abs(t.excel)*100:null}]; })) }));
}

const daily = summarizeGroups(d => d);
const weekly = summarizeGroups(isoWeek);
const monthly = summarizeGroups(d => d.slice(0,7));
function levelStats(groups) {
  return Object.fromEntries(metrics.map(m => {
    const ps=groups.map(g=>g.totals[m.name].absPct).filter(Number.isFinite).sort((a,b)=>a-b);
    const weightedExcel=groups.reduce((s,g)=>s+g.totals[m.name].excel,0), weightedServer=groups.reduce((s,g)=>s+g.totals[m.name].server,0);
    return [m.name,{count:ps.length,meanAbsPct:ps.reduce((a,b)=>a+b,0)/ps.length,medianAbsPct:ps.length%2?ps[(ps.length-1)/2]:(ps[ps.length/2-1]+ps[ps.length/2])/2,maxAbsPct:ps.at(-1),aggregateSignedPct:weightedExcel?(weightedServer-weightedExcel)/weightedExcel*100:null,aggregateAbsPct:weightedExcel?Math.abs(weightedServer-weightedExcel)/Math.abs(weightedExcel)*100:null,excelTotal:weightedExcel,serverTotal:weightedServer}];
  }));
}
const totalName="총 진료비";
const largestDaily=[...daily].sort((a,b)=>b.totals[totalName].absPct-a.totals[totalName].absPct).slice(0,10).map(g=>({date:g.key,...g.totals[totalName]}));
const dailyTotal = daily.map(g=>({date:g.key,...g.totals[totalName]}));
const validDaily = dailyTotal.filter(x=>Number.isFinite(x.absPct));
const dailyDiagnostics = {
  zeroExcel: dailyTotal.filter(x=>x.excel===0),
  within1Pct: validDaily.filter(x=>x.absPct<=1).length,
  within3Pct: validDaily.filter(x=>x.absPct<=3).length,
  within5Pct: validDaily.filter(x=>x.absPct<=5).length,
  over10Pct: validDaily.filter(x=>x.absPct>10).length,
  meanExcludingLargest1: [...validDaily].sort((a,b)=>b.absPct-a.absPct).slice(1).reduce((s,x)=>s+x.absPct,0)/(validDaily.length-1),
  meanExcludingLargest2: [...validDaily].sort((a,b)=>b.absPct-a.absPct).slice(2).reduce((s,x)=>s+x.absPct,0)/(validDaily.length-2),
};
console.log(JSON.stringify({rowCount:rows.length,dateRange:[rows[0]?.date,rows.at(-1)?.date],stats:{daily:levelStats(daily),weekly:levelStats(weekly),monthly:levelStats(monthly)},weeklyTotalFee:weekly.map(g=>({week:g.key,range:[g.first,g.last],days:g.days,...g.totals[totalName]})),monthlyTotalFee:monthly.map(g=>({month:g.key,days:g.days,...g.totals[totalName]})),largestDaily,dailyDiagnostics},null,2));
