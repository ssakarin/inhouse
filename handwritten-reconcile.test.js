const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require('./handwritten-reconcile');
const { classifyNoncoveredVisit } = require('./server/noncovered-breakdown');

const D = '2026-11-17';
const HEAD = 'date,row,chart_no,name,visit_type,insurance,memo,treatment,amount,pay_group,payment,unpaid,prepaid,confidence';
const csv = lines => h.parseCsv([HEAD, ...lines].join('\n')).rows;
const patient = (chartNo, name, entry, extra = {}) => ({ patientId: String(chartNo), chartNo: String(chartNo), name, visitHistory: entry === undefined ? {} : { [D]: entry }, ...extra });

function preview(rows, patients) {
  const byChart = new Map(patients.map(p => [p.chartNo, [p]]));
  return h.buildPreview({
    date: D, rows,
    dayPatients: patients.filter(p => p.visitHistory[D]),
    lookupChart: chart => byChart.get(String(chart)) || []
  });
}
const item = (p, key) => p.items.find(i => i.key === String(key));

test('parseCsv handles BOM, quotes, commas in amounts and reports bad rows', () => {
  const { rows, errors } = h.parseCsv(`﻿${HEAD}\n${D},1,8650,천수남,,,"메모, 쉼표",,"2,400",,,,,\n${D},2,abc,오류,,,,,100,,,,,\n${D},3,1,가,,,,,x,,,,,`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 2400);
  assert.equal(rows[0].memo, '메모, 쉼표');
  assert.equal(errors.length, 2);
  assert.throws(() => h.parseCsv('date,row\n'), /필수 열/);
});

test('requires Excel data for the date and matching note date', () => {
  const rows = csv([`${D},1,1,가,,,,,2400,,,,,`]);
  assert.throws(() => preview(rows, [patient(1, '가', { treatments: [] })]), /엑셀을 먼저/);
  assert.throws(() => preview(csv([`2026-11-16,1,1,가,,,,,2400,,,,,`]), [patient(1, '가', { insuredCopay: 2400 })]), /다릅니다/);
});

test('missing visit, noncovered difference, 1종, rounding and Excel-only rows', () => {
  const patients = [
    patient(1, '본인', { insuredCopay: 2400, nonCoveredAmount: 0 }),
    patient(2, '누락', undefined),
    patient(3, '약침', { insuredCopay: 2400, nonCoveredAmount: 0 }),
    patient(4, '일종', { insuredCopay: 1000, nonCoveredAmount: 0 }, { insuranceType: '의료급여1종' }),
    patient(5, '절사', { insuredCopay: 5250, nonCoveredAmount: 0 }),
    patient(6, '엑셀만', { insuredCopay: 3000, nonCoveredAmount: 0 }),
    patient(7, '보드만', { treatments: ['약침'] })
  ];
  const p = preview(csv([
    `${D},1,1,본인,,,공하①,,2400,,,,,`,
    `${D},2,2,누락,재초진,,,,2400,,,,,`,
    `${D},3,3,약침,,,공하①,약침,7400,,,,,`,
    `${D},4,4,일종,,1종,,,0,,,,,`,
    `${D},5,5,절사,,,,,5200,,,,,`,
    `${D},7,7,보드만,,,공하①,약침,7400,,,,,`
  ]), patients);
  assert.deepEqual(item(p, 1).kinds, ['same']);
  assert.equal(item(p, 1).checked, false);
  assert.deepEqual(item(p, 2).kinds, ['missing']);
  assert.deepEqual(item(p, 2).after, { insuredCopay: 2400, nonCoveredAmount: 0 });
  assert.equal(item(p, 3).after.nonCoveredAmount, 5000);
  assert.equal(item(p, 3).checked, true);
  assert.deepEqual(item(p, 4).after, { insuredCopay: 0, nonCoveredAmount: 0 });
  assert.ok(item(p, 4).kinds.includes('class1'));
  assert.deepEqual(item(p, 5).kinds, ['same']);
  assert.deepEqual(item(p, 7).kinds, ['missing']);
  assert.equal(item(p, 7).after.nonCoveredAmount, 7400);
  assert.deepEqual(p.excelOnly.map(x => x.chartNo), ['6']);
});

test('grouped payment, unpaid, prepaid, large amount, less, alias and blocked rows', () => {
  const patients = [
    patient(10, '갑', { insuredCopay: 2400, nonCoveredAmount: 0 }),
    patient(11, '을', { insuredCopay: 1000, nonCoveredAmount: 0 }, { insuranceType: '1종' }),
    patient(12, '미수', { insuredCopay: 1000, nonCoveredAmount: 0 }, { insuranceType: '1종' }),
    patient(13, '선결', { insuredCopay: 0, nonCoveredAmount: 0 }),
    patient(14, '적음', { insuredCopay: 2400, nonCoveredAmount: 9000 }),
    patient(13758, '김영호', { insuredCopay: 4800, nonCoveredAmount: 28000 }),
    patient(15, '다른이름', { insuredCopay: 100 })
  ];
  const p = preview(csv([
    `${D},1,10,갑,,,공하①,3번약침,15800,1,,,,`,
    `${D},2,11,을,,1종,,,0,1,,,,`,
    `${D},3,12,미수,재초진,1종,치료약×1달,,1000,,,300000,,`,
    `${D},4,13,선결,,,,,0,,,,㉘,`,
    `${D},5,14,적음,,,,약침,7400,,,,,`,
    `${D},6,13758,김영훈,,,2부위,3번약침×2,32800,,,,,`,
    `${D},7,15,노트이름,,,,,100,,,,,`,
    `${D},8,99999,없음,,,,,100,,,,,`
  ]), patients);
  // 합산 결제: 1종 1,000원 차감 후 남은 차액은 약침 표시가 있는 갑에게
  assert.deepEqual(item(p, 2).after, { insuredCopay: 0, nonCoveredAmount: 0 });
  assert.deepEqual(item(p, 1).after, { insuredCopay: 2400, nonCoveredAmount: 13400 });
  assert.equal(item(p, 1).checked, true);
  // 미수는 매출 포함, 10만 원 이상은 기본 해제
  assert.equal(item(p, 3).after.nonCoveredAmount, 300000);
  assert.equal(item(p, 3).after.insuredCopay, 1000);
  assert.equal(item(p, 3).checked, false);
  assert.ok(item(p, 4).kinds.includes('prepaid'));
  assert.equal(item(p, 4).checked, false);
  assert.ok(item(p, 5).kinds.includes('less'));
  assert.equal(item(p, 5).after.nonCoveredAmount, 5000);
  assert.equal(item(p, 5).checked, false);
  assert.equal(item(p, 6).blocked, '');
  assert.deepEqual(item(p, 6).kinds, ['same']);
  assert.match(item(p, 7).blocked, /이름 불일치/);
  assert.match(item(p, 8).blocked, /desk에서 먼저 등록/);
});

test('applyDecision adds or updates the visit amounts and keeps the note record', () => {
  const p = preview(csv([`${D},2,2,누락,재초진,,,약침,7400,,카,,,`, `${D},3,3,약침,,,,약침,7400,,카,,,`]),
    [patient(2, '누락', undefined, { visitDates: ['2026-11-01'] }), patient(3, '약침', { insuredCopay: 2400, nonCoveredAmount: 0, treatments: ['약침'] })]);
  assert.equal(item(p, 3).category, undefined);
  const added = h.applyDecision(patient(2, '누락', undefined, { visitDates: ['2026-11-01'] }), D, item(p, 2), { insuredCopay: 2400, nonCoveredAmount: 5000 }, 'now');
  assert.deepEqual(added.visitDates, ['2026-11-01', D]);
  assert.equal(added.visitHistory[D].visitType, '초진');
  assert.equal(added.visitHistory[D].handwritten.added, true);
  assert.equal(added.visitHistory[D].noncoveredCategory, undefined);
  const original = patient(3, '약침', { insuredCopay: 2400, nonCoveredAmount: 0, treatments: ['약침'] });
  const updated = h.applyDecision(original, D, item(p, 3), { insuredCopay: 2400, nonCoveredAmount: 5000 }, 'now');
  assert.equal(original.visitHistory[D].nonCoveredAmount, 0);
  assert.deepEqual(updated.visitHistory[D].treatments, ['약침']);
  assert.equal(updated.visitHistory[D].handwritten.before.nonCoveredAmount, 0);
  assert.throws(() => h.applyDecision(original, D, item(p, 3), { insuredCopay: -1, nonCoveredAmount: 0 }, 'now'), /금액/);
});

test('auto classification reads the note text saved on handwritten visits', () => {
  const classify = (handwritten, amount, entry = {}) => classifyNoncoveredVisit({
    patient: { visitHistory: { [D]: { treatments: [], ...entry, handwritten } } }, visit: { noncovered_amount: amount }, date: D
  });
  assert.equal(classify(undefined, 5000), 'other');
  assert.equal(classify({ treatment: '4번약침+복추', memo: '' }, 22000), 'pharmaSingle');
  assert.equal(classify({ treatment: '', memo: '치료약×1달' }, 300000), 'generalHerbal');
  assert.equal(classify({ treatment: '약침', memo: '리다이어트×12주 2부위' }, 557800), 'dietHerbal');
  assert.equal(classify({ treatment: '왕뜸', memo: '' }, 1600), 'other');
});

test('desk merge keeps handwritten fields when Excel is re-imported', () => {
  const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const fn = name => html.slice(html.indexOf(`  function ${name}(`), html.indexOf('\n  }\n', html.indexOf(`  function ${name}(`)) + 4);
  const src = ['visitStatFields', 'mergeChartVisitHistory'].map(fn).join('\n')
    + "\nconst VISIT_STAT_FIELDS=['diagnosisCode','totalFee','claimAmount','insuredCopay','nonCoveredAmount'];"
    + '\nfunction normalizeBodyParts(v){return Array.isArray(v)?v:[];}\nfunction normalizeMemo2History(){return {};}\nmodule.exports=mergeChartVisitHistory;';
  const m = { exports: null };
  new Function('module', src)(m);
  const existing = { visitHistory: { [D]: { insuredCopay: 0, nonCoveredAmount: 5000, handwritten: { row: 3 } } } };
  const merged = m.exports(existing, { visitEntries: [{ date: D, insuredCopay: 1000, nonCoveredAmount: 0 }] });
  assert.equal(merged.visitHistory[D].insuredCopay, 1000);
  assert.deepEqual(merged.visitHistory[D].handwritten, { row: 3 });
});

test('OCR fixes: suggestions for blocked rows and re-preview with corrected chart/name', () => {
  const patients = [
    patient(7324, '임태숙', { insuredCopay: 0, nonCoveredAmount: 7400 }),
    patient(8384, '정치선', { insuredCopay: 0, nonCoveredAmount: 7400 }),
    patient(553, '김순자', { insuredCopay: 0, nonCoveredAmount: 10000 })
  ];
  const rows = csv([
    `${D},3,17324,임태숙,,,,약침,7400,,카,,,`,
    `${D},6,8384,정채선,,,,약침,7400,,,,,`,
    `${D},38,5573,김순자,,,,약침,10000,,카,,,`
  ]);
  const p = preview(rows, patients);
  assert.deepEqual(item(p, 3).suggestions.map(s => [s.chartNo, s.name, s.reason]), [['7324', '임태숙', '이름 같음']]);
  assert.deepEqual(item(p, 6).suggestions.map(s => s.name), ['정치선']);
  assert.equal(item(p, 6).suggestions[0].reason, '차트번호 같음');
  assert.deepEqual(item(p, 38).suggestions.map(s => s.chartNo), ['553']);

  const fixed = h.applyRowFixes(rows, { 3: { chart_no: '7324', name: '임태숙' }, 6: { chart_no: '8384', name: '정치선' }, 38: { chart_no: '553', name: '김순자' } });
  const q = preview(fixed, patients);
  assert.equal(q.summary.blocked, 0);
  assert.match(item(q, 3).notes[0], /OCR 수정: 임태숙 17324 → 임태숙 7324/);
  assert.ok(item(q, 3).kinds.includes('same'));
  assert.throws(() => h.applyRowFixes(rows, { 3: { chart_no: '73a4', name: '임태숙' } }), /숫자만/);
  assert.throws(() => h.applyRowFixes(rows, { 3: { chart_no: '7324', name: ' ' } }), /이름/);
  assert.equal(h.applyRowFixes(rows, { 3: { chart_no: '17324', name: '임태숙' } })[0], rows[0]);
});
