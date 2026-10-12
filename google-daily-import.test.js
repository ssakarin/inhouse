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
 const result=context.saveDailyMetrics([{date:old.date,insuredCopay:0,referrals:{소개:0}}],'구글시트',true);
 assert.equal(result.days,1);
 const saved=JSON.parse(decrypt(db.prepare('SELECT data_json FROM daily_clinic_metrics').get().data_json));assert.deepEqual(saved,{...old,insuredCopay:0,referrals:{소개:0,간판:3}});
 const backup=JSON.parse(decrypt(db.prepare('SELECT previous_json FROM daily_clinic_metrics_imports').get().previous_json));assert.deepEqual(JSON.parse(decrypt(backup[0].data_json)),old);
 assert.throws(()=>context.saveDailyMetrics([{date:old.date,insuredCopay:-1}],'bad',true));assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_clinic_metrics_imports').get().n,1);db.close();
});
