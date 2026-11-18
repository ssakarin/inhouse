// 수기 진료 노트(OCR CSV)와 서버에 저장된 엑셀 내원 기록을 대조해 보정안을 만든다.
// CSV는 /handwritten-ocr 스킬이 만들고, util '수기차트 대조' 카드가 업로드한다.
// 서버에는 금액만 고친다. 비급여 종류는 구글시트 반영 때 server/noncovered-breakdown.js가 자동 분류한다.

const COLUMNS = ['date', 'row', 'chart_no', 'name', 'visit_type', 'insurance', 'memo', 'treatment', 'amount', 'pay_group', 'payment', 'unpaid', 'prepaid', 'confidence'];
const REQUIRED = ['date', 'row', 'chart_no', 'name', 'amount'];
const IGNORE_DIFF = 100;
const LARGE_AMOUNT = 100000;

// 노트 이름 ↔ 서버(엑셀) 이름이 다르지만 같은 사람 (차트번호 기준)
const NAME_ALIASES = {
  13758: ['김영훈', '김영호'], 13710: ['박기란', '박기완'], 11261: ['노창대', '손창대'],
  11962: ['윤종등', '윤종승'], 13211: ['최경하', '최경화'], 1657: ['조또례', '조소례'],
  14046: ['노동연', '노승연'], 9335: ['원춘랑', '원춘광'], 240: ['천정순', '권정순'],
  11029: ['장태섭', '장태성'], 8910: ['최흥기', '최홍기']
};

const text = v => String(v ?? '').normalize('NFC').trim();
const nameKey = v => text(v).replace(/\s+/g, '');
const num = v => {
  const s = text(v).replace(/[,원\s]/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
const statNum = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function parseCsv(source) {
  const records = [];
  let field = '', record = [], quoted = false;
  const input = String(source || '').replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some(v => text(v))) records.push(record);
      record = [];
    } else field += c;
  }
  record.push(field);
  if (record.some(v => text(v))) records.push(record);
  if (!records.length) throw Error('CSV가 비어 있습니다.');
  const header = records[0].map(h => text(h).toLowerCase());
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) throw Error(`CSV에 필수 열이 없습니다: ${missing.join(', ')}`);
  const rows = [], errors = [];
  records.slice(1).forEach((values, index) => {
    const raw = Object.fromEntries(COLUMNS.map(c => [c, text(values[header.indexOf(c)] ?? '')]));
    const line = index + 2;
    const row = {
      ...raw,
      row: Number(raw.row),
      chart_no: raw.chart_no.replace(/\.0$/, ''),
      amount: num(raw.amount),
      unpaid: num(raw.unpaid),
      confidence: raw.confidence.toLowerCase() || 'high'
    };
    if (!Number.isInteger(row.row) || row.row < 1) errors.push(`${line}행: row가 올바르지 않습니다.`);
    else if (!/^\d+$/.test(row.chart_no)) errors.push(`${line}행(노트 ${row.row}번): 차트번호가 올바르지 않습니다.`);
    else if (!Number.isFinite(row.amount) || !Number.isFinite(row.unpaid)) errors.push(`${line}행(노트 ${row.row}번): 금액이 숫자가 아닙니다.`);
    else rows.push(row);
  });
  const seen = new Set();
  rows.forEach(r => { if (seen.has(r.row)) errors.push(`노트 ${r.row}번 행이 중복됩니다.`); seen.add(r.row); });
  return { rows, errors };
}

// 처치/비고에 비급여 항목 표시가 있는지 (본인부담만 있는 행과 구분)
function hasNoncoveredMark(row) {
  return /약침|자하거수|한약|치료약|처방|다이어트|녹용|경옥고|공진단|패키지|왕뜸|파스|약×/.test(`${row.treatment} ${row.memo}`);
}

function isAutoInsurance(row, patient) {
  return /자보|자동차/.test(`${row.insurance} ${patient?.insuranceType || ''}`);
}
function isClass1(row, patient) {
  return /1종/.test(`${row.insurance} ${patient?.insuranceType || ''}`);
}

function entryStats(entry) {
  return {
    insuredCopay: statNum(entry?.insuredCopay),
    nonCoveredAmount: statNum(entry?.nonCoveredAmount),
    claimAmount: statNum(entry?.claimAmount),
    totalFee: statNum(entry?.totalFee)
  };
}
const paidOf = s => (s.insuredCopay || 0) + (s.nonCoveredAmount || 0);
const hasStats = entry => ['insuredCopay', 'nonCoveredAmount', 'claimAmount', 'totalFee'].some(k => statNum(entry?.[k]) !== null);

function namesMatch(chartNo, noteName, serverName) {
  if (nameKey(noteName) === nameKey(serverName)) return true;
  const alias = NAME_ALIASES[Number(chartNo)];
  return Boolean(alias && alias.includes(nameKey(noteName)) && alias.includes(nameKey(serverName)));
}

function resolvePatient(row, lookupChart) {
  const candidates = lookupChart(row.chart_no) || [];
  if (!candidates.length) return { blocked: `서버에 차트번호 ${row.chart_no} 환자가 없습니다. desk에서 먼저 등록하세요.` };
  const match = candidates.find(p => namesMatch(row.chart_no, row.name, p.name));
  if (match) return { patient: match };
  return { blocked: `이름 불일치: 노트 ${row.name} / 서버 ${candidates.map(p => p.name).join(', ')}. 차트번호를 확인하세요.` };
}

/**
 * @param {object} args
 * @param {string} args.date 선택한 진료일
 * @param {object[]} args.rows parseCsv 결과 rows
 * @param {object[]} args.dayPatients 서버에서 그 날짜 내원 기록이 있는 환자 레코드
 * @param {(chartNo:string)=>object[]} args.lookupChart 차트번호로 환자 레코드 조회
 */
function buildPreview({ date, rows, dayPatients, lookupChart }) {
  const wrongDates = [...new Set(rows.map(r => r.date).filter(d => d !== date))];
  if (wrongDates.length) throw Error(`CSV 날짜(${wrongDates.join(', ')})가 선택한 날짜 ${date}와 다릅니다.`);
  if (!rows.length) throw Error('CSV에 반영할 행이 없습니다.');
  if (!dayPatients.some(p => hasStats(p.visitHistory?.[date]))) {
    throw Error(`${date} 엑셀 진료 내역이 서버에 없습니다. desk에서 엑셀을 먼저 불러오세요.`);
  }

  const items = rows.map(row => {
    const { patient, blocked } = resolvePatient(row, lookupChart);
    const entry = patient?.visitHistory?.[date];
    const exists = Boolean(entry);
    const before = entryStats(entry);
    return {
      key: String(row.row), row, patientId: patient?.patientId || '', chartNo: row.chart_no,
      name: row.name, serverName: patient?.name || '', insuranceType: patient?.insuranceType || '',
      exists, excelMissing: !hasStats(entry), before, blocked: blocked || '',
      after: { insuredCopay: before.insuredCopay ?? 0, nonCoveredAmount: before.nonCoveredAmount ?? 0 },
      kinds: [], notes: [], checked: true,
      handwrittenAmount: row.amount + row.unpaid,
      _patient: patient
    };
  });

  const groups = new Map();
  items.forEach(item => {
    const key = item.row.pay_group || `row${item.row.row}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  for (const members of groups.values()) {
    const grouped = members.length > 1;
    if (grouped) members.forEach(m => m.notes.push(`합산 결제 (${members.map(x => `${x.row.row}번`).join('·')})`));
    if (members.some(m => m.blocked)) {
      members.forEach(m => { m.checked = false; m.kinds.push(m.blocked ? 'blocked' : 'group-blocked'); if (!m.blocked) m.notes.push('같은 합산 결제에 반영 불가 환자가 있어 함께 보류'); });
      continue;
    }
    members.forEach(m => {
      if (m.excelMissing) m.kinds.push('missing');
      if (m.row.unpaid) m.notes.push(`미수 ${m.row.unpaid.toLocaleString()}원 매출 포함`);
      if (m.row.prepaid) { m.kinds.push('prepaid'); m.checked = false; m.notes.push(`선결제 ${m.row.prepaid} — 금액을 반영하려면 체크 후 입력`); }
      if (m.row.confidence === 'low') { m.checked = false; m.notes.push('OCR 판독 불확실'); }
    });

    const billable = members.filter(m => !isAutoInsurance(m.row, m._patient) && !m.row.prepaid);
    members.filter(m => !billable.includes(m)).forEach(m => { if (isAutoInsurance(m.row, m._patient)) m.notes.push('자보: 금액 비교 제외'); });
    if (!billable.length) continue;

    // 엑셀에 없는 내원은 그 행 금액을 우선 배정한다 (처치 표시가 없으면 본인부담).
    billable.filter(m => m.excelMissing).forEach(m => {
      const own = m.row.amount + m.row.unpaid;
      if (hasNoncoveredMark(m.row)) {
        m.after.nonCoveredAmount = own;
        if (own) m.notes.push('본인부담/비급여 구분 확인');
      } else m.after.insuredCopay = own;
    });

    const handwritten = billable.reduce((s, m) => s + m.row.amount + m.row.unpaid, 0);
    let diff = handwritten - billable.reduce((s, m) => s + paidOf(m.after), 0);

    // 1종: 본인부담금을 수기 값에 맞춘다 (보통 엑셀 1,000 → 노트 0)
    billable.filter(m => isClass1(m.row, m._patient) && !m.excelMissing).forEach(m => {
      if (diff === 0) return;
      // 합산 결제에서는 1종 환자 줄이 0원이면 본인부담 0으로 본다 (합계가 엑셀과 같으면 손대지 않음).
      const target = grouped
        ? (m.row.amount + m.row.unpaid === 0 ? 0 : m.after.insuredCopay)
        : Math.max(0, m.handwrittenAmount - m.after.nonCoveredAmount);
      const change = target - m.after.insuredCopay;
      if (!change || Math.abs(change) > 1000) return;
      m.after.insuredCopay = target; diff -= change; m.kinds.push('class1');
      m.notes.push(`1종 본인부담 ${m.before.insuredCopay ?? 0} → ${target}`);
    });

    if (Math.abs(diff) < IGNORE_DIFF) {
      if (diff) billable[0].notes.push(`${diff}원 차이 무시 (절사)`);
      continue;
    }
    const marked = billable.filter(m => hasNoncoveredMark(m.row));
    const target = marked.length === 1 ? marked[0] : billable.length === 1 ? billable[0] : (marked[0] || billable[0]);
    if (billable.length > 1 && marked.length !== 1) { target.checked = false; target.notes.push('합산 결제 차액 배분 대상 확인'); }
    if (diff > 0) {
      target.after.nonCoveredAmount += diff;
      target.kinds.push('diff');
      target.notes.push(`비급여 +${diff.toLocaleString()}원`);
      if (diff >= LARGE_AMOUNT) { target.checked = false; target.notes.push('10만 원 이상 — 직접 확인'); }
    } else {
      target.after.nonCoveredAmount = Math.max(0, target.after.nonCoveredAmount + diff);
      target.kinds.push('less');
      target.checked = false;
      target.notes.push(`수기가 엑셀보다 ${(-diff).toLocaleString()}원 적음 — 비급여 차감 제안`);
    }
  }

  items.forEach(item => {
    const changed = !item.exists || item.after.insuredCopay !== (item.before.insuredCopay ?? 0) || item.after.nonCoveredAmount !== (item.before.nonCoveredAmount ?? 0);
    if (!item.blocked && !changed && !item.kinds.includes('prepaid')) item.kinds.push('same');
    if (item.kinds.includes('same')) item.checked = false;
    if (item.blocked) item.checked = false;
    delete item._patient;
  });

  const noted = new Set(items.map(i => i.patientId).filter(Boolean));
  const excelOnly = dayPatients
    .filter(p => !noted.has(p.patientId) && p.visitHistory?.[date])
    .map(p => ({ patientId: p.patientId, chartNo: p.chartNo, name: p.name, ...entryStats(p.visitHistory[date]) }))
    .sort((a, b) => Number(a.chartNo) - Number(b.chartNo));

  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const summary = {
    rows: items.length,
    handwrittenTotal: sum(items, i => i.handwrittenAmount),
    serverTotal: sum(dayPatients, p => paidOf(entryStats(p.visitHistory?.[date]))),
    missing: items.filter(i => i.kinds.includes('missing')).length,
    changed: items.filter(i => !i.kinds.includes('same') && !i.blocked).length,
    blocked: items.filter(i => i.blocked).length,
    excelOnly: excelOnly.length
  };
  return { date, items, excelOnly, summary };
}

/** 확정한 보정 1건을 환자 레코드에 적용한 새 레코드를 돌려준다 (원본 불변). */
function applyDecision(patient, date, item, decision, appliedAt) {
  const copay = Number(decision.insuredCopay), noncovered = Number(decision.nonCoveredAmount);
  if (![copay, noncovered].every(v => Number.isFinite(v) && v >= 0)) throw Error(`노트 ${item.key}번: 금액이 올바르지 않습니다.`);
  const record = { ...patient, visitHistory: { ...(patient.visitHistory || {}) } };
  const existing = record.visitHistory[date];
  const entry = existing ? { ...existing } : {
    treatments: [], bodyParts: [], doctorName: '', nurseId: '', nurseName: '',
    visitType: /초진/.test(item.row.visit_type) ? '초진' : '재진', chiefComplaint: ''
  };
  entry.insuredCopay = copay;
  entry.nonCoveredAmount = noncovered;
  entry.handwritten = {
    appliedAt, row: item.row.row, added: !existing,
    before: entryStats(existing),
    amount: item.row.amount, unpaid: item.row.unpaid || 0, prepaid: item.row.prepaid || '',
    payment: item.row.payment || '', treatment: item.row.treatment || '', memo: item.row.memo || ''
  };
  record.visitHistory[date] = entry;
  if (Array.isArray(record.visitDates) && !record.visitDates.includes(date)) record.visitDates = [...record.visitDates, date].sort();
  return record;
}

module.exports = { parseCsv, buildPreview, applyDecision, entryStats, NAME_ALIASES };
