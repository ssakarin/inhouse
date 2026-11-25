"use strict";

// Reconcile against the complete committed tree, never a tablet's partial SSE view.
function reconcileAssignmentAlerts(alerts = {}, beds = {}) {
  const next = {};
  for (const [key, alert] of Object.entries(alerts)) {
    if (!alert?.patientKey) continue;
    const entry = Object.entries(beds).find(([, bed]) =>
      bed?.patientKey === alert.patientKey && !bed.bedCleaning);
    if (!entry) continue;
    const [no, bed] = entry;
    const bedNo = Number(no);
    if (Number(alert.bedNo) === bedNo) {
      next[key] = alert;
      continue;
    }
    const bedLabel = bedNo >= 901 && bedNo <= 920 ? '다음 치료 대기'
      : bedNo >= 101 ? `원장실${bedNo - 100}` : bedNo === 15 ? '스파인' : `${bedNo}번`;
    next[key] = { ...alert, bedNo, bedLabel,
      patientName: bed.name || alert.patientName || '',
      doctorId: bed.doctorId || alert.doctorId || '',
      doctorName: bed.doctorName || alert.doctorName || '',
      nurseId: bed.nurseId || alert.nurseId || '',
      nurseName: bed.nurseName || alert.nurseName || '',
      message: `${bedLabel} ${bed.name || alert.patientName || '환자'} 배정` };
  }
  return next;
}

function startInitialExamOnConfirmation(beds, alert, now = Date.now()) {
  const no = Number(alert?.bedNo);
  if (!Number.isInteger(no) || !((no >= 1 && no <= 15 && no !== 7) || (no >= 101 && no <= 110))) return null;
  const bed = beds?.[String(no)];
  if (!bed || !alert.patientKey || bed.patientKey !== alert.patientKey
    || bed.complete || bed.bedCleaning || bed.running || bed.lastAlertId || Number(bed.doctorProcedureStartedAt) > 0) return null;
  const index = Number(bed.currentIndex || 0);
  const treatment = bed.treatments?.[index] || '';
  const initialExam = index === 0 && bed.initialExamOnArrival !== false && ['진찰', '베드진찰'].includes(treatment);
  const returnProcedure = (no === 15 || no >= 101)
    && (alert.returnFromWaiting === true || alert.directProcedureArrival === true)
    && Number(alert.treatmentIndex) === index && alert.treatmentName === treatment
    && (['진찰', '베드진찰', '단추', '복추', '추나', '벤치', '적외선', '테이핑'].includes(treatment) || /약침/.test(treatment));
  if (!initialExam && !returnProcedure) return null;
  return { ...beds, [no]: { ...bed, initialExamOnArrival: false,
    doctorProcedureStartedAt: now, doctorProcedureStartedIndex: index,
    doctorProcedureStartedTreatment: treatment } };
}

module.exports = { reconcileAssignmentAlerts, startInitialExamOnConfirmation };
