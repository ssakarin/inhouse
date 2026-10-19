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

module.exports = { reconcileAssignmentAlerts };
