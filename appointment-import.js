(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AppointmentImport = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const text = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const chart = value => text(value).replace(/^0+(?=\d)/, '');
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function dateValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value < 1 || value > 109574) throw Error('예약 날짜를 확인해주세요');
      value = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
    }
    const normalized = text(value).replace(/[./]/g, '-');
    const match = normalized.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    const result = match ? `${match[1]}-${match[2]}-${match[3]}` : normalized;
    if (!validDate(result)) throw Error('예약 날짜를 확인해주세요');
    return result;
  }
  function timeValue(value) {
    if (value === '' || value == null) return '';
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw Error('예약 시각을 확인해주세요');
      const seconds = Math.round(value * 86400);
      if (seconds >= 86400) throw Error('예약 시각을 확인해주세요');
      return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`;
    }
    const raw = text(value);
    const match = raw.match(/^(?:(오전|오후|am|pm|tt)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?$/i);
    if (!match) throw Error('예약 시각을 확인해주세요');
    let hour = Number(match[2]);
    const meridiem = (match[1] || match[5] || '').toLowerCase();
    if (['오전', '오후', 'am', 'pm'].includes(meridiem) && (hour < 1 || hour > 12)) throw Error('예약 시각을 확인해주세요');
    if ((meridiem === '오후' || meridiem === 'pm') && hour < 12) hour += 12;
    if ((meridiem === '오전' || meridiem === 'am') && hour === 12) hour = 0;
    if (hour > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) throw Error('예약 시각을 확인해주세요');
    return `${String(hour).padStart(2, '0')}:${match[3]}`;
  }
  function validate(entries, clearDates = []) {
    if (!Array.isArray(entries) || entries.length > 20000 || !Array.isArray(clearDates) || clearDates.length > 366) throw Error('예약명단 형식을 확인해주세요');
    const byDate = new Map();
    const clears = new Set(clearDates.map(dateValue));
    for (const date of clears) byDate.set(date, []);
    for (const [index, row] of entries.entries()) {
      try {
        const item = { date: dateValue(row.date), chartNo: chart(row.chartNo), name: text(row.name),
          time: timeValue(row.time), doctorName: text(row.doctorName), ...(text(row.note) ? { note: text(row.note) } : {}) };
        if (!/^\d{1,30}$/.test(item.chartNo) || !item.name || item.name.length > 100 || item.doctorName.length > 100 || (item.note || '').length > 2000) throw Error('차트번호와 환자명을 확인해주세요');
        if (clears.has(item.date)) throw Error('같은 날짜를 불러오기와 비우기에 동시에 지정할 수 없습니다');
        if (!byDate.has(item.date)) byDate.set(item.date, []);
        byDate.get(item.date).push(item);
      } catch (error) { throw Error(`${index + 1}번째 예약: ${error.message}`); }
    }
    if (!byDate.size) throw Error('예약 데이터가 없습니다. 예약이 0명인 날짜는 날짜를 지정하여 명단을 비워주세요');
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
      const unique = [...new Map(rows.map(row => [JSON.stringify([row.chartNo, row.name, row.time, row.doctorName]), row])).values()];
      return { date, entries: unique };
    });
  }
  function parseWorkbook(XLSX, workbook) {
    const aliases = [ ['진료예약일자', '예약일자', '예약일'], ['예약시각', '예약시간'],
      ['환자명', '수진자명', '성명'], ['담당의사', '예약의사', '담당의'], ['차트번호'] ];
    const entries = [];
    let found = false;
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      const headerIndex = rows.slice(0, 20).findIndex(row => aliases.every(names => row.some(cell => names.includes(text(cell).replace(/\s/g, '')))));
      if (headerIndex < 0) continue;
      found = true;
      const headers = rows[headerIndex].map(cell => text(cell).replace(/\s/g, ''));
      const columns = aliases.map(names => headers.findIndex(header => names.includes(header)));
      const noteColumn = headers.findIndex(header => ['예약내역', '예약내용'].includes(header));
      for (let index = headerIndex + 1; index < rows.length; index++) {
        const row = rows[index];
        if (!row.some(cell => text(cell))) continue;
        try {
          const item = { date: dateValue(row[columns[0]]), time: timeValue(row[columns[1]]),
            name: text(row[columns[2]]), doctorName: text(row[columns[3]]), chartNo: chart(row[columns[4]]),
            ...(noteColumn >= 0 && text(row[noteColumn]) ? { note: text(row[noteColumn]) } : {}) };
          validate([item]);
          entries.push(item);
        } catch (error) { throw Error(`${sheetName} ${index + 1}행: ${error.message}`); }
      }
    }
    if (!found) throw Error('동의보감 예약 파일의 진료예약일자·예약시각·환자명·담당의사·차트번호 열을 찾지 못했습니다');
    validate(entries);
    return entries;
  }
  function patientsOf(entries) {
    const patients = new Map();
    for (const row of entries) {
      const key = JSON.stringify([row.chartNo, row.name]);
      if (!patients.has(key)) patients.set(key, { chartNo: row.chartNo, name: row.name, appointmentSlots: [] });
      patients.get(key).appointmentSlots.push({ time: row.time, doctorName: row.doctorName, ...(row.note ? { note: row.note } : {}) });
    }
    return [...patients.values()].map(patient => {
      patient.appointmentSlots.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.doctorName.localeCompare(b.doctorName, 'ko'));
      return { ...patient, time: patient.appointmentSlots[0]?.time || '', doctorName: patient.appointmentSlots[0]?.doctorName || '' };
    }).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.name.localeCompare(b.name, 'ko'));
  }
  function compare(previous, next) {
    const map = rows => new Map(patientsOf(rows).map(patient => [JSON.stringify([patient.chartNo, patient.name]), JSON.stringify(patient.appointmentSlots)]));
    const old = map(previous), current = map(next);
    return { previousCount: old.size, count: current.size,
      added: [...current.keys()].filter(key => !old.has(key)).length,
      removed: [...old.keys()].filter(key => !current.has(key)).length,
      changed: [...current.keys()].filter(key => old.has(key) && old.get(key) !== current.get(key)).length };
  }
  return { text, validDate, dateValue, timeValue, validate, parseWorkbook, patientsOf, compare };
});
