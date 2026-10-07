const test=require('node:test');
const assert=require('node:assert/strict');
const dm=require('./daily-metrics');
test('only selected fields survive validation; blank differs from explicit zero',()=>{
  assert.deepEqual(dm.validate([{date:'2025-01-02',nonCoveredAmount:0,claimAmount:null,patientCount:47,referrals:{소개:2}}]),[{date:'2025-01-02',nonCoveredAmount:0,referrals:{소개:2}}]);
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
 assert.equal(s.trendStats[0].avgCombinedFeePerVisit,null);assert.equal(s.dailyMetrics.operational.appointmentCount.value,2);assert.equal(s.dailyMetrics.operational.noShowCount.days,0);
 assert.equal(dm.overlay(base,[],board,()=> '202501'),base);
});
test('operational-only import does not change board financial totals',()=>{
 const base={financialTotals:{totalFee:100}};const s=dm.overlay(base,[{date:'2025-01-02',appointmentCount:0}],[],()=> '202501');
 assert.deepEqual(s.financialTotals,base.financialTotals);assert.equal(s.dailyMetrics.operational.appointmentCount.days,1);
});
