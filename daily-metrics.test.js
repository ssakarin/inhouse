const test=require('node:test');
const assert=require('node:assert/strict');
const dm=require('./daily-metrics');
test('only selected fields survive validation; blank differs from explicit zero',()=>{
  assert.deepEqual(dm.validate([{date:'2025-01-02',nonCoveredAmount:0,claimAmount:null,patientCount:47,age65PatientCount:20,referrals:{소개:2}}]),[{date:'2025-01-02',nonCoveredAmount:0,patientCount:47,referrals:{소개:2}}]);
  assert.throws(()=>dm.validate([{date:'2025-02-30'}]));
  assert.throws(()=>dm.validate([{date:'2025-01-02'},{date:'2025-01-02'}]));
  assert.throws(()=>dm.validate([{date:'2025-01-02',noShowCount:-1}]));
});
test('date-specific overrides replace, never add; missing fields and dates fall back',()=>{
 const base={visits:3,financialTotals:{totalFee:150,nonCoveredAmount:50},trendStats:[{key:'202501',clinicDays:2,newPatients:1}]};
 const board=[{date:'2025-01-02',visits:2,totalFee:100,insuredCopay:20,claimAmount:70,autoAmount:10,nonCoveredAmount:30},{date:'2025-01-03',visits:1,totalFee:50,insuredCopay:10,claimAmount:40,autoAmount:0,nonCoveredAmount:20}];
 const rows=[{date:'2025-01-02',nonCoveredAmount:0,insuredCopay:25,appointmentCount:2,referrals:{소개:1}}];
 const s=dm.overlay(base,rows,board,()=> '202501');
 assert.deepEqual(s.financialTotals,{totalFee:155,insuredCopay:35,claimAmount:110,nonCoveredAmount:20,autoAmount:10});
 assert.equal(s.visits,3);assert.equal(s.trendStats[0].newPatients,1);assert.equal(s.trendStats[0].avgCombinedFeePerDay,87.5);
 assert.equal(s.trendStats[0].avgCombinedFeePerVisit,175/3);assert.equal(s.dailyMetrics.operational.appointmentCount.value,2);assert.equal(s.dailyMetrics.operational.noShowCount.days,0);
 assert.equal(dm.overlay(base,[],board,()=> '202501'),base);
});
test('operational-only import does not change board financial totals',()=>{
 const base={financialTotals:{totalFee:100}};const s=dm.overlay(base,[{date:'2025-01-02',appointmentCount:0}],[],()=> '202501');
 assert.deepEqual(s.financialTotals,base.financialTotals);assert.equal(s.dailyMetrics.operational.appointmentCount.days,1);
});

test('patient counts stay separate from cohorts; blanks and non-clinic days do not lower averages',()=>{
 const base={newPatients:4,coreVisits:9,returnRate:.5,trendStats:[{key:'202501',newPatients:4,returnRate:.5,clinicDays:2}]};
 const rows=[{date:'2025-01-02',patientCount:40,newPatientCount:0,returnPatientCount:40,reinitialPatientCount:2},{date:'2025-01-03',patientCount:60,returnPatientCount:57},{date:'2025-01-04',patientCount:0,newPatientCount:0,returnPatientCount:0}];
 const s=dm.overlay(base,rows,[],()=> '202501');
 assert.deepEqual(s.dailyMetrics.patients.patientCount,{value:100,days:2,average:50});
 assert.deepEqual(s.dailyMetrics.patients.newPatientCount,{value:0,days:1,average:0});
 assert.deepEqual(s.dailyMetrics.patients.reinitialPatientCount,{value:2,days:1,average:2});
 assert.equal(s.newPatients,4);assert.equal(s.coreVisits,9);assert.equal(s.returnRate,.5);
 assert.equal(s.trendStats[0].returnRate,.5);assert.equal(s.trendStats[0].dailyPatientCounts.returnPatientCount.value,97);
 assert.equal(base.trendStats[0].dailyPatientCounts,undefined);
 assert.throws(()=>dm.validate([{date:'2025-01-02',returnPatientCount:1.5}]));
 assert.throws(()=>dm.validate([{date:'2025-01-02',reinitialPatientCount:-1}]));
});

test('patient trends survive financial overlay and group by the requested period',()=>{
 const s=dm.overlay({trendStats:[]},[{date:'2025-01-02',patientCount:40,insuredCopay:10},{date:'2025-02-03',patientCount:20,newPatientCount:3}],[],date=>date.slice(0,7));
 assert.equal(s.trendStats.length,2);assert.equal(s.trendStats[0].dailyPatientCounts.patientCount.average,40);
 assert.equal(s.trendStats[1].dailyPatientCounts.newPatientCount.value,3);
 assert.equal(s.financialTotals.insuredCopay,10);
 assert.equal(s.dailyMetrics.patients.patientCount.value,60);
});

test('workbook import maps all four counts and reports an invalid count without inventing a replacement',()=>{
 const rows=[['일자','본인부담금','当日','당일 환자수','신규 환자수','재진 환자수','재초진 환자수','취합'],['2025-08-01',100,null,50,1,-1,null,'Y'],['2025-08-02',100,null,40,0,40,2,'Y'],['2025-08-02',null,null,'detail',null,null,null,'N']];
 const X={utils:{sheet_to_json:()=>rows}};
 const p=dm.parseWorkbook({SheetNames:['일간 데이터'],Sheets:{'일간 데이터':{}}},X);
 assert.equal(p.rows.length,2);assert.equal(p.rows[0].patientCount,50);assert.equal(p.rows[0].newPatientCount,1);
 assert.equal(Object.hasOwn(p.rows[0],'returnPatientCount'),false);assert.equal(Object.hasOwn(p.rows[0],'reinitialPatientCount'),false);
 assert.equal(p.rows[1].returnPatientCount,40);assert.equal(p.rows[1].newPatientCount,0);assert.equal(p.rows[1].reinitialPatientCount,2);
 assert.deepEqual(p.warnings,['2025-08-01 재진환자수: -1 (등록 제외)']);
});

test('imported per-visit fee uses manual counts with server fallback and null for no visits',()=>{
 const base={trendStats:[]};const imports=[{date:'2026-08-01',insuredCopay:100,patientCount:10},{date:'2026-08-02',insuredCopay:200},{date:'2026-09-01',insuredCopay:100,patientCount:0}];const board=[{date:'2026-08-01',visits:5},{date:'2026-08-02',visits:20}];const s=dm.overlay(base,imports,board,d=>d.slice(0,7));assert.equal(s.dailyMetrics.perVisitCount,30);assert.equal(s.trendStats.find(r=>r.key==='2026-08').avgCombinedFeePerVisit,10);assert.equal(s.trendStats.find(r=>r.key==='2026-09').avgCombinedFeePerVisit,null);
});

test('empty imported calendar slots remain gaps; explicit zero on visit dates stays zero',()=>{
 const base={trendStats:[]};const rows=[{date:'2026-10-01',insuredCopay:0,nonCoveredAmount:0},{date:'2026-10-02',patientCount:0},{date:'2026-10-03',insuredCopay:0,nonCoveredAmount:0},{date:'2026-10-04',patientCount:1}];const board=[{date:'2026-10-01',visits:1,totalFee:0,nonCoveredAmount:0},{date:'2026-10-04',visits:1,totalFee:0,nonCoveredAmount:0,hasCombinedFinance:0,hasNoncoveredFinance:0}];const s=dm.overlay(base,rows,board,d=>d);const get=d=>s.trendStats.find(r=>r.key===d);assert.equal(get('2026-10-01').avgCombinedFeePerDay,0);for(const d of ['2026-10-02','2026-10-03','2026-10-04']){assert.equal(get(d).avgCombinedFeePerDay,null);assert.equal(get(d).avgNonCoveredFeePerDay,null);}
});

test('referral analysis uses recorded channels, preserves zero and reports same-day new-patient discrepancies',()=>{
 const result=dm.referralAnalysis([{date:'2026-01-01',newPatientCount:10,referrals:{'지인 소개':3,간판:2}},{date:'2026-01-02',newPatientCount:50},{date:'2026-01-03',newPatientCount:4,referrals:{지인소개:4,간판:0}},{date:'2026-01-04',referrals:{간판:1}}]);
 assert.equal(result.days,3);assert.equal(result.total,10);assert.equal(result.newPatients,14);assert.equal(result.matchedNewPatientDays,2);assert.deepEqual(result.channels,[{label:'지인소개',count:7,share:.7},{label:'간판',count:3,share:.3}]);assert.deepEqual(result.discrepancies,[{date:'2026-01-01',newPatientCount:10,referralCount:5}]);assert.equal(dm.referralAnalysis([]).total,0);
});

test('auto fee trends distinguish missing days and explicit zero and preserve patient averages',()=>{
 const rows=[{date:'2026-10-01',patientCount:10,autoAmount:1000},{date:'2026-10-02',patientCount:20,autoAmount:0},{date:'2026-10-03',patientCount:30},{date:'2026-10-04',patientCount:0,autoAmount:0}];
 const s=dm.overlay({trendStats:[]},rows,[],d=>d.slice(0,7));
 assert.deepEqual(s.dailyMetrics.finance.autoAmount,{value:1000,days:2,average:500});
 assert.deepEqual(s.trendStats[0].dailyFinanceCounts.autoAmount,s.dailyMetrics.finance.autoAmount);
 assert.equal(s.trendStats[0].dailyPatientCounts.patientCount.average,20);
 const missing=dm.overlay({trendStats:[]},[{date:'2026-10-01',patientCount:10}],[],d=>d);
 assert.equal(missing.trendStats[0].dailyFinanceCounts.autoAmount.average,null);
});
