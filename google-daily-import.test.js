const test=require('node:test'),assert=require('node:assert/strict'),g=require('./google-daily-import');
const X={SSF:{parse_date_code:n=>({y:2026,m:1,d:n})}};
const h=['일자','본인부담금','당일 환자수','신규 환자수','재진 환자수','취합'];
test('range, aggregate filtering, explicit zero, blanks and patient warning',()=>{
 const p=g.parse([h,[1,0,40,1,-1,'Y'],[1,10,2,1,1,'N'],[2,null,30,null,30,'Y'],[3,50,40,1,39,'Y']],'일간데이터',X,'2026-01-01','2026-01-02');
 assert.equal(p.rows.length,2);assert.equal(p.rows[0].insuredCopay,0);assert.equal(p.rows[0].returnPatientCount,undefined);assert.equal(p.rows[1].insuredCopay,undefined);assert.equal(p.warnings.length,1);
 assert.throws(()=>g.range('2026-02-30','2026-03-01'));assert.throws(()=>g.range('2026-01-03','2026-01-01'));
});
test('reject duplicate dates and skip invalid financial values',()=>{
 assert.throws(()=>g.parse([h,[1,0,40,1,39,'Y'],[1,10,40,1,39,'Y']],'日',X,'2026-01-01','2026-01-02'),/중복/);
 const p=g.parse([h,[1,'#REF!',40,1,39,'Y'],[2,10,40,1,39,'Y']],'日',X,'2026-01-01','2026-01-02');assert.equal(p.rows.length,1);assert.equal(p.warnings.length,1);
});
test('merge preserves missing fields and referral channels; preview does not mutate',()=>{
 const old={date:'2026-01-01',insuredCopay:100,nonCoveredAmount:50,referrals:{소개:2,간판:3}};
 const row={date:old.date,insuredCopay:0,referrals:{소개:0}};
 assert.deepEqual(g.merge(old,row),{...old,insuredCopay:0,referrals:{소개:0,간판:3}});
 const p=g.preview([row],[old]);assert.equal(p[0].changes.length,2);assert.equal(p[0].isNew,false);assert.equal(old.insuredCopay,100);
});

test('database import preserves blank fields and records encrypted previous values for recovery',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{DatabaseSync}=require('node:sqlite');
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE daily_clinic_metrics(date TEXT PRIMARY KEY,data_json TEXT NOT NULL,source_file TEXT NOT NULL,imported_at TEXT NOT NULL); CREATE TABLE daily_clinic_metrics_imports(id INTEGER PRIMARY KEY,source_file TEXT,imported_at TEXT,previous_json TEXT);');
 const encrypt=v=>'enc:'+v,decrypt=v=>v.slice(4);
 const old={date:'2026-01-01',insuredCopay:100,nonCoveredAmount:50,referrals:{소개:2,간판:3}};
 db.prepare('INSERT INTO daily_clinic_metrics VALUES(?,?,?,?)').run(old.date,encrypt(JSON.stringify(old)),'old.xlsx','old-time');
 const source=fs.readFileSync('server/server.js','utf8');const start=source.indexOf('function saveDailyMetrics('),end=source.indexOf('// 1회 마이그레이션',start);
 const context={db,dailyMetrics:require('./daily-metrics'),googleDailyImport:g,encrypt,decrypt};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const result=context.saveDailyMetrics([{date:old.date,insuredCopay:0,referrals:{소개:0},nonCoveredAmount:1300,nonCoveredBreakdown:{일반한약:1300,약침:0}}],'구글시트',true);
 assert.equal(result.days,1);
 const saved=JSON.parse(decrypt(db.prepare('SELECT data_json FROM daily_clinic_metrics').get().data_json));assert.deepEqual(saved,{...old,insuredCopay:0,referrals:{소개:0,간판:3},nonCoveredAmount:1300,nonCoveredBreakdown:{일반한약:1300,약침:0}});
 const backup=JSON.parse(decrypt(db.prepare('SELECT previous_json FROM daily_clinic_metrics_imports').get().previous_json));assert.deepEqual(JSON.parse(decrypt(backup[0].data_json)),old);
 assert.throws(()=>context.saveDailyMetrics([{date:old.date,insuredCopay:-1}],'bad',true));assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_clinic_metrics_imports').get().n,1);db.close();
});

 test('Excel and Google import combine payment blocks by category, including detail rows and zero',()=>{
 const dm=require('./daily-metrics');const header=Array(42).fill('');
 header[0]='일자';header[1]='취합';header[26]='본인부담금';header[28]='비급여매출';header[32]='항목_최초결제';header[36]='금액_최초결제';header[37]='항목_재결제';header[41]='금액_재결제';
 const aggregate=Array(42).fill(null);aggregate[0]='2026-01-01';aggregate[1]='Y';aggregate[26]=10;aggregate[28]=1500;
 const a=Array(42).fill(null);a[32]='일반 한약';a[36]='1,000';a[37]='약침';a[41]=200;
 const b=Array(42).fill(null);b[32]='약침';b[36]=0;b[37]='일반한약';b[41]=300;
 const c=Array(42).fill(null);c[0]='2026-01-02';c[1]='Y';c[26]=20;c[28]=0;const d=Array(42).fill(null);d[32]='기타';d[36]=0;
 const values=[header,aggregate,a,b,c,d],XLSX={...X,utils:{sheet_to_json:()=>values}};
 const expected={일반한약:1300,약침:200};
 const excel=dm.parseWorkbook({SheetNames:['일간데이터'],Sheets:{일간데이터:{}}},XLSX);
 const google=g.parse(values,'일간데이터',XLSX,'2026-01-01','2026-01-01');
 assert.deepEqual(excel.rows[0].nonCoveredBreakdown,expected);assert.deepEqual(google.rows[0].nonCoveredBreakdown,expected);
 assert.deepEqual(excel.rows[1].nonCoveredBreakdown,{기타:0});assert.equal(google.rows.length,1);
 assert.equal(google.rows[0].nonCoveredAmount,1500);
 const old={date:aggregate[0],nonCoveredBreakdown:{일반한약:500,기타:70}};
 const merged=g.merge(old,google.rows[0]);assert.deepEqual(merged.nonCoveredBreakdown,{...expected,기타:70});
 assert.equal(g.preview(google.rows,[old])[0].changes.find(c=>c.key==='비급여: 일반한약').after,1300);
 assert.throws(()=>dm.validate([{date:aggregate[0],nonCoveredBreakdown:{기타:-1}}]));
 aggregate[28]=1400;assert.throws(()=>g.parse(values,'日',XLSX,'2026-01-01','2026-01-01'),/일치/);assert.throws(()=>dm.parseWorkbook({SheetNames:['일간데이터'],Sheets:{일간데이터:{}}},XLSX),/일치/);
 aggregate[28]=null;assert.throws(()=>g.parse(values,'日',XLSX,'2026-01-01','2026-01-01'),/공란/);aggregate[28]=1500;
 a[36]='#REF!';assert.throws(()=>dm.parseWorkbook({SheetNames:['일간데이터'],Sheets:{일간데이터:{}}},XLSX),/상세 금액 오류/);
 });

test('actual sheet headers, summary rows and repeated payment suffixes import correctly',()=>{
 const dm=require('./daily-metrics'),header=Array(43).fill('');header[1]='일자';header[26]='본인부담금';header[28]='비급여매출';header[32]='비급여';header[36]='비급여\n합계';header[37]='비급여\n_재결제';header[41]='비급여합계\n_재결제';header[42]='취합';
 const sum=Array(43).fill(null);sum[1]=46024;sum[26]=100;sum[28]=870000;sum[32]=true;sum[36]=0;sum[37]='-';sum[41]=870000;sum[42]='Y';
 const rows=[header,sum];for(const [label,amount] of [['일반한약',600000],['약침(1회성)',80000],['약침패키지',50000],['비급여8',140000]]){const r=Array(43).fill(null);r[1]=46024;r[32]=label;r[37]=label+' 재결제';r[41]=amount;rows.push(r);}
 const x={SSF:{parse_date_code:()=>({y:2026,m:1,d:2})},utils:{sheet_to_json:()=>rows}},expected={일반한약:600000,'약침(1회성)':80000,약침패키지:50000,비급여8:140000};
 assert.deepEqual(g.parse(rows,'일간데이터',x,'2026-01-02','2026-01-02').rows[0].nonCoveredBreakdown,expected);
 assert.deepEqual(dm.parseWorkbook({SheetNames:['일간데이터'],Sheets:{일간데이터:{}}},x).rows[0].nonCoveredBreakdown,expected);
});

test('Excel and Google report every mismatching date and prevent import',()=>{
 const dm=require('./daily-metrics'),header=Array(43).fill('');header[1]='일자';header[26]='본인부담금';header[28]='비급여매출';header[32]='비급여';header[36]='비급여합계';header[42]='취합';
 const rows=[header];for(const [date,total,detail] of [['2026-01-01',100,200],['2026-01-02',300,200],['2026-01-03',null,50],['2026-01-04',50,50]]){const a=Array(43).fill(null);a[1]=date;a[26]=0;a[28]=total;a[42]='Y';const d=Array(43).fill(null);d[1]=date;d[32]='일반한약';d[36]=detail;rows.push(a,d);}
 const x={utils:{sheet_to_json:()=>rows}};
 const check=error=>{assert.match(error.message,/3일/);for(const date of ['2026-01-01','2026-01-02','2026-01-03'])assert.ok(error.message.includes(date));assert.ok(!error.message.includes('2026-01-04'));assert.match(error.message,/차액 100원/);assert.match(error.message,/차액 -100원/);assert.match(error.message,/공란/);return true;};
 assert.throws(()=>g.parse(rows,'일간데이터',x,'2026-01-01','2026-01-04'),check);
 assert.throws(()=>dm.parseWorkbook({SheetNames:['일간데이터'],Sheets:{일간데이터:{}}},x),check);
});
