// Shared by the statistics page and server to preserve identical cohort rules.
(function(root) {
'use strict';
  const today = () => ymd(new Date());
  function ymd(date) {
    const d = new Date(date);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }



  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function visitDatesOf(rec) {
    const dates = Array.isArray(rec.visitDates) ? rec.visitDates.map(String) : [];
    Object.keys(rec.visitHistory || {}).forEach(d => dates.push(String(d)));
    return [...new Set(dates.filter(Boolean))].sort();
  }

  function isPrescriptionChiefComplaint(value) {
    const text = String(value || "").trim().replace(/\s+/g, "");
    return text === "처방" || text === "-처방-";
  }

  function isPrescriptionVisit(rec, date) {
    const history = rec.visitHistory || {};
    if (Object.prototype.hasOwnProperty.call(history, date)) {
      return isPrescriptionChiefComplaint(history[date]?.chiefComplaint);
    }
    return isPrescriptionChiefComplaint(rec.chiefComplaint);
  }

  function normalizeVisitType(value) {
    const text = String(value || "").trim().replace(/\s+/g, "");
    if (text.includes("초")) return "초진";
    if (text.includes("재")) return "재진";
    return "";
  }

  function getVisitRecord(rec, date) {
    return (rec.visitHistory || {})[date] || {};
  }

  function explicitNewVisitDatesOf(rec) {
    return visitDatesOf(rec).filter(date => normalizeVisitType(getVisitRecord(rec, date).visitType) === "초진");
  }

  function newVisitDatesOf(rec) {
    const explicitDates = explicitNewVisitDatesOf(rec);
    if (explicitDates.length) return explicitDates;
    const dates = visitDatesOf(rec);
    return dates.length ? [dates[0]] : [];
  }

  function nonPrescriptionVisitDatesOf(rec) {
    return visitDatesOf(rec).filter(date => !isPrescriptionVisit(rec, date));
  }

  function computeFollowupAnalysis(records, start, end, doctor = '') {
    const cutoff = end < addDays(today(), -1) ? end : addDays(today(), -1);
    const result = { entries: [], pending: 0 };
    const dayNumber = date => Date.parse(date + 'T00:00:00Z') / 86400000;
    for (const rec of records) {
      const dates = nonPrescriptionVisitDatesOf(rec);
      const starts = newVisitDatesOf(rec);
      for (const first of starts) {
        if (first < start || first > cutoff || isPrescriptionVisit(rec, first)) continue;
        const visit = getVisitRecord(rec, first);
        if (doctor && String(visit.doctorName || rec.doctorName || '').trim() !== doctor) continue;
        if (dayNumber(cutoff) - dayNumber(first) < 21) { result.pending++; continue; }
        const nextStart = starts.find(date => date > first);
        const gaps = dates.filter(date => date > first && date <= cutoff && (!nextStart || date < nextStart))
          .map(date => dayNumber(date) - dayNumber(first)).filter(days => days <= 21);
        const rawInsurance = String(visit.insuranceType || rec.insuranceType || rec.insurance_type || rec['보험종별'] || '').trim();
        const insurance = /자보|자동차|^TA$/i.test(rawInsurance) ? '자보' : /1종/.test(rawInsurance) ? '1종' : /2종/.test(rawInsurance) ? '2종' : /건강|건보|직장|지역/.test(rawInsurance) ? '건강보험' : rawInsurance ? '기타' : '미상';
        const rawAge = String(visit.age ?? rec.age ?? '').trim();
        const age = /^\d+(?:세)?$/.test(rawAge) ? Number(rawAge.replace('세', '')) : NaN;
        const ageLabel = !Number.isFinite(age) || age > 120 ? '미상' : age < 20 ? '20세 미만' : age < 40 ? '20~39세' : age < 60 ? '40~59세' : age < 65 ? '60~64세' : '65세 이상';
        const rawGender = String(visit.gender || rec.gender || '').trim();
        const gender = /^(남|남성|남자|M|male)$/i.test(rawGender) ? '남' : /^(여|여성|여자|F|female)$/i.test(rawGender) ? '여' : '미상';
        result.entries.push({ insurance, age: ageLabel, gender, weekday: ['일','월','화','수','목','금','토'][new Date(first + 'T00:00:00Z').getUTCDay()], second: gaps[0] ?? null, third: gaps[1] ?? null });
      }
    }
    return result;
  }
if (typeof module !== 'undefined' && module.exports) module.exports = { computeFollowupAnalysis };
else root.computeFollowupAnalysis = computeFollowupAnalysis;
})(typeof globalThis !== 'undefined' ? globalThis : this);
