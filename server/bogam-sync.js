'use strict';
const appointments = require('../appointment-import');
const crypto = require('node:crypto');

function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
function range(value) {
  const start = value?.start, end = value?.end;
  if (!appointments.validDate(start) || !appointments.validDate(end) || start > end
      || (Date.parse(end) - Date.parse(start)) / 86400000 > 365) throw failure('INVALID_RANGE');
  return { start, end };
}
function ranges(body) {
  const scope = body?.scope || 'all';
  if (!['all','visits','bookings'].includes(scope)) throw failure('INVALID_RANGE');
  return { ...(body?.scope ? { scope } : {}), visits: scope === 'bookings' ? null : range(body?.visits),
    bookings: scope === 'visits' ? null : range(body?.bookings) };
}
function date(value) { return appointments.dateValue(String(value ?? '').slice(0, 10)); }
function time(value, preserveSeconds = false) {
  let text = String(value ?? '').trim();
  if (/^\d{4}(\d{2})?$/.test(text)) text = `${text.slice(0, 2)}:${text.slice(2, 4)}${text.length === 6 ? ':' + text.slice(4) : ''}`;
  const result = appointments.timeValue(text);
  const seconds = text.match(/^\d{1,2}:\d{2}:(\d{2})$/)?.[1] || '00';
  return preserveSeconds && result ? `${result}:${seconds}` : result;
}
function cleanText(value, max = 100) {
  const result = appointments.text(value);
  if (!result || result.length > max) throw failure('INVALID_SOURCE_DATA');
  return result;
}
const insuranceNames = { '1': '건강보험', '2': '의료급여', '4': '자동차' };
const visitTypes = { '11': '초진', '12': '재진', '14': '無診', '42': '자보(재)' };
const amounts = ['totalFee', 'claimAmount', 'insuredCopay', 'nonCoveredAmount'];
function optionalText(value, max = 100) {
  const result = appointments.text(value);
  if (!result) return undefined;
  if (result.length > max) throw failure('INVALID_SOURCE_DATA');
  return result;
}
function numeric(value, integer = false) {
  if (value == null || value === '' || (typeof value === 'string' && !value.trim())) return undefined;
  if (!['number', 'string'].includes(typeof value)) throw failure('INVALID_SOURCE_DATA');
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER || (integer && (!Number.isSafeInteger(n) || n < 0))) throw failure('INVALID_SOURCE_DATA');
  return n;
}
function visitFields(row) {
  const fields = {};
  const age = numeric(row.ageAtVisit, true);
  if (age !== undefined) { if (age > 150) throw failure('INVALID_SOURCE_DATA'); fields.ageAtVisit = age; }
  const sex = optionalText(row.sex, 20);
  if (sex === '남' || sex === '여') fields.gender = sex;
  for (const [source, target, max] of [['mobile','phone',100], ['insuranceCode','bogamInsuranceCode',30],
    ['insuranceDetailCode','bogamInsuranceDetailCode',30], ['visitModeCode','bogamVisitModeCode',30]]) {
    const value = optionalText(row[source], max);
    if (value !== undefined) fields[target] = value;
  }
  if (Object.hasOwn(insuranceNames, fields.bogamInsuranceCode)) fields.bogamInsuranceCategory = insuranceNames[fields.bogamInsuranceCode];
  if (Object.hasOwn(visitTypes, fields.bogamVisitModeCode)) fields.visitType = visitTypes[fields.bogamVisitModeCode];
  const none = numeric(row.noneInsurance, true);
  if (none !== undefined) fields.bogamNoneInsurance = none;
  const pair = `${fields.bogamInsuranceCode}:${fields.bogamInsuranceDetailCode}`;
  const labels = { '1:0':'건강보험', '1:3':'차상2종', '2:1':'급여1종', '2:2':'급여2종' };
  if (none === 0 && Object.hasOwn(labels, pair)) fields.insuranceType = labels[pair];
  if (none === 1 && pair === '1:0') fields.insuranceType = '비*건강보험';
  if (none === 0 && fields.bogamInsuranceCode === '4'
      && ['17','18','19'].includes(fields.bogamInsuranceDetailCode)
      && numeric(row.insurerNameVariants, true) === 1 && numeric(row.insurerCaptionVariants, true) === 1) {
    const name = typeof row.insurerName === 'string' ? row.insurerName.replace(/ +$/, '') : '';
    const caption = typeof row.insurerCaption === 'string' ? row.insurerCaption.replace(/ +$/, '') : '';
    // Compare before whitespace normalization: no unverified precedence between
    // inc_Name and inc_Caption, even if they differ only by internal spacing.
    if (name.trim() && name.length <= 200 && name === caption) fields.insuranceType = `자보:${name}`;
  }
  if (numeric(row.primaryDiagnosisRows, true) === 1) {
    const code = optionalText(row.diagnosisCode);
    if (code !== undefined) fields.diagnosisCode = code;
    if (numeric(row.diagnosisNameVariants, true) === 1) {
      const name = optionalText(row.diagnosisName, 1000);
      if (name !== undefined) fields.chiefComplaint = name;
    }
  }
  // Only totalFee depends on Account cardinality. DigBill's three columns are
  // independently verified; never substitute receipts or invent sums.
  for (const name of amounts) {
    if (name === 'totalFee' && numeric(row.accountRows, true) !== 1) continue;
    const value = numeric(row[name]); if (value !== undefined) fields[name] = value;
  }
  return fields;
}
function normalize(payload, requested) {
  if (!payload || !Array.isArray(payload.visits) || !Array.isArray(payload.bookings)
      || payload.visits.length > 10000 || payload.bookings.length > 10000) throw failure('INVALID_SOURCE_DATA');
  if ((requested.scope === 'visits' && payload.bookings.length)
      || (requested.scope === 'bookings' && payload.visits.length)) throw failure('INVALID_SOURCE_DATA');
  const identity = row => {
    const chartNo = appointments.text(row.chartNo).replace(/^0+(?=\d)/, '');
    if (!/^\d{1,30}$/.test(chartNo)) throw failure('INVALID_SOURCE_DATA');
    return { chartNo, name: cleanText(row.name), doctorName: cleanText(row.doctorName) };
  };
  const within = (value, period) => {
    const result = date(value);
    if (result < period.start || result > period.end) throw failure('INVALID_SOURCE_DATA');
    return result;
  };
  const seen = new Map();
  const visits = payload.visits.map(row => {
    const item = { ...identity(row), date: within(row.date, requested.visits),
      receptionTime: time(row.receptionTime, true), diagnosisTime: time(row.diagnosisTime),
      diagnosisId: cleanText(row.diagnosisId), customerId: cleanText(row.customerId), fields: visitFields(row) };
    if (!item.receptionTime) throw failure('INVALID_SOURCE_DATA');
    const key = JSON.stringify([item.diagnosisId, item.customerId, item.date]);
    const previous = seen.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw failure('AMBIGUOUS_SOURCE_DATA');
    seen.set(key, item);
    return item;
  });
  const bookings = payload.bookings.map(row => ({ ...identity(row), date: within(row.date, requested.bookings), time: time(row.time), ...(optionalText(row.note, 2000) ? { note: optionalText(row.note, 2000) } : {}) }));
  // Apply the same validation/slot deduplication as manual Excel imports.
  const groups = bookings.length ? appointments.validate(bookings) : [];
  return { scope: requested.scope || 'all', visits: [...new Map(visits.map(row => [JSON.stringify([row.diagnosisId, row.customerId, row.date]), row])).values()], groups };
}

// Only verified fields may overwrite their counterparts. Board-authored clinical
// notes, treatments, packages and corrections remain unchanged. Diagnosis names
// change only when the primary row and effective distinct name are both unique.
function planPatients(visits, getByChart, stats = {}) {
  const patients = new Map(), changedDates = new Map(), namesByChart = new Map(), existingByChart = new Map();
  for (const row of visits) {
    if (!namesByChart.has(row.chartNo)) namesByChart.set(row.chartNo, new Set());
    namesByChart.get(row.chartNo).add(row.name);
  }
  const blockedCharts = new Set();
  for (const [chart, names] of namesByChart) {
    const existing = getByChart(chart);
    existingByChart.set(chart, existing);
    if (names.size > 1 || (existing.length && !existing.some(p => names.has(appointments.text(p.name))))) blockedCharts.add(chart);
  }
  // Like Excel: preflight the whole input so BOTH names of a conflicting chart
  // are skipped, including its earlier rows. Never partially update that chart.
  stats.skippedPatients = [...blockedCharts].reduce((n,chart) => n + namesByChart.get(chart).size, 0);
  stats.skippedVisits = visits.filter(row => blockedCharts.has(row.chartNo)).length;
  const ordered = [...visits].sort((a,b) => a.date.localeCompare(b.date)
    || a.receptionTime.localeCompare(b.receptionTime) || a.diagnosisId.localeCompare(b.diagnosisId));
  for (const row of ordered) {
    if (blockedCharts.has(row.chartNo)) continue;
    const identity = JSON.stringify([row.chartNo, row.name]);
    if (!patients.has(identity)) {
      const matches = existingByChart.get(row.chartNo);
      const old = matches.find(p => appointments.text(p.name) === row.name);
      patients.set(identity, { ...(old || {}), chartNo: row.chartNo, name: row.name,
        visitHistory: { ...(old?.visitHistory || {}) }, visitDates: [...(old?.visitDates || [])],
        bogamVisitRecords: { ...(old?.bogamVisitRecords || {}) } });
      changedDates.set(identity, new Set());
    }
    const patient = patients.get(identity);
    // This is the authoritative source record, NOT a customer/date aggregate.
    const visitKey = JSON.stringify([row.diagnosisId, row.customerId, row.date]);
    const fields = row.fields || {};
    patient.bogamVisitRecords[visitKey] = { ...(patient.bogamVisitRecords[visitKey] || {}), ...fields,
      diagnosisId: row.diagnosisId, customerId: row.customerId, date: row.date,
      timestamp: Date.parse(`${row.date}T${row.receptionTime.length === 5 ? row.receptionTime + ':00' : row.receptionTime}+09:00`),
      diagnosisTime: row.diagnosisTime, doctorName: row.doctorName };
    changedDates.get(identity).add(row.date);
    if (fields.phone) patient.phone = fields.phone;
    if (fields.gender) patient.gender = fields.gender;
  }
  for (const [identity, patient] of patients) {
    const byDate = new Map();
    for (const record of Object.values(patient.bogamVisitRecords)) {
      if (!byDate.has(record.date)) byDate.set(record.date, []);
      byDate.get(record.date).push(record);
    }
    patient.visitDates = [...new Set([...patient.visitDates, ...Object.keys(patient.visitHistory), ...byDate.keys()])].sort();
    patient.latestDate = patient.visitDates.at(-1) || '';
    patient.bogamMultipleVisitDates = [...byDate].filter(([,rows]) => rows.length > 1).map(([date]) => date).sort();
    // Preserve compatibility with current date-based board screens only when a
    // date has exactly one source visit. Multiple visits stay separate above;
    // do not choose one, sum amounts, or combine diagnoses into a daily record.
    for (const date of changedDates.get(identity)) {
      const rows = byDate.get(date);
      if (rows.length !== 1) continue;
      const { diagnosisId, customerId, date: sourceDate, diagnosisTime, ...fields } = rows[0];
      patient.visitHistory[date] = { ...(patient.visitHistory[date] || {}), ...fields };
      if (date !== patient.latestDate) continue;
      if (fields.ageAtVisit !== undefined) patient.age = fields.ageAtVisit;
      if (fields.visitType) patient.visitType = fields.visitType;
      patient.doctorName = fields.doctorName;
      if (fields.chiefComplaint !== undefined) patient.chiefComplaint = fields.chiefComplaint;
      for (const key of ['bogamInsuranceCode','bogamInsuranceDetailCode','bogamInsuranceCategory','bogamVisitModeCode','bogamNoneInsurance']) {
        if (fields[key] !== undefined) patient[key] = fields[key];
      }
      if (fields.insuranceType !== undefined) patient.insuranceType = fields.insuranceType;
    }
  }
  return [...patients.values()];
}

function createCoordinator({ fetchSource, apply, publish, initialStatus = {}, applyEnabled = false, enabled = false }) {
  const legacyStamps = initialStatus.lastAppliedAt && (!initialStatus.scope || initialStatus.scope === 'all')
    ? { visits: initialStatus.lastAppliedAt, bookings: initialStatus.lastAppliedAt } : {};
  let active = null, state = { ...initialStatus, lastAppliedAtByScope: { ...legacyStamps, ...(initialStatus.lastAppliedAtByScope || {}) },
    running: false, enabled, applyEnabled };
  const update = patch => { state = { ...state, ...patch }; publish(state); };
  function run(body) {
    const requested = ranges(body);
    if (!enabled) return Promise.reject(failure('SYNC_DISABLED', 503));
    const key = JSON.stringify(requested);
    if (active) return active.key === key ? active.promise : Promise.reject(failure('SYNC_BUSY', 409));
    const id = crypto.randomUUID();
    // Install the shared promise before publishing/starting any asynchronous IO.
    const promise = Promise.resolve().then(async () => {
      update({ running: true, phase: 'querying', code: null, requestId: id, ranges: requested, scope: requested.scope || 'all' });
      try {
        const result = await fetchSource({ ...requested, requestId: id, dryRun: !applyEnabled });
        if (!result || result.ok !== true) throw failure('INVALID_SOURCE_DATA');
        if (requested.scope && result.scope !== requested.scope) throw failure('BRIDGE_UPDATE_REQUIRED', 409);
        if (result.dryRun || !applyEnabled) {
          const counts = result.counts;
          if (!counts || !['visits', 'bookings', 'unmappedDoctors'].every(k => Number.isInteger(counts[k]) && counts[k] >= 0)
              || !Number.isFinite(result.elapsedMs)) throw failure('INVALID_SOURCE_DATA');
          update({ running: false, phase: 'validated', counts, elapsedMs: result.elapsedMs, readOnlyVerified: result.readOnlyVerified === true });
          return { ok: true, dryRun: true, counts, elapsedMs: result.elapsedMs, readOnlyVerified: result.readOnlyVerified === true };
        }
        const data = normalize(result, requested);
        update({ phase: 'applying' });
        const applied = apply(data); // synchronous, one local SQLite transaction
        const counts = { visits: data.visits.length - (applied.skippedVisits || 0), bookings: data.groups.reduce((n, g) => n + g.entries.length, 0),
          multipleVisitDays: applied.multipleVisitDays || 0, skippedPatients: applied.skippedPatients || 0,
          skippedVisits: applied.skippedVisits || 0 };
        update({ running: false, phase: 'completed', lastAppliedAt: applied.appliedAt,
          lastAppliedAtByScope: applied.lastAppliedAtByScope || state.lastAppliedAtByScope,
          counts, elapsedMs: result.elapsedMs });
        return { ok: true, ...applied, counts, elapsedMs: result.elapsedMs };
      } catch (error) {
        const allowed = ['DESK_UNREACHABLE', 'SYNC_TIMEOUT', 'SYNC_BUSY', 'SOURCE_REJECTED', 'BRIDGE_UPDATE_REQUIRED', 'READ_ONLY_ACCOUNT_REQUIRED',
          'INVALID_SOURCE_DATA', 'AMBIGUOUS_SOURCE_DATA', 'PATIENT_IDENTITY_CONFLICT', 'UNMAPPED_DOCTOR', 'SOURCE_NOT_CONFIGURED'];
        const code = allowed.includes(error.code) ? error.code : 'SYNC_FAILED';
        update({ running: false, phase: 'failed', code });
        throw failure(code, error.statusCode || 502);
      } finally { active = null; }
    });
    active = { key, promise };
    return promise;
  }
  return { run, status: () => ({ ...state }) };
}
module.exports = { failure, range, ranges, date, time, normalize, planPatients, createCoordinator };
