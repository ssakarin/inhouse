// Persist stage entry on the server so acknowledgment and bed moves cannot
// reorder patients who are already waiting for the same procedure priority.
function patientIdentity(bed) {
  return bed?.patientKey || bed?.chartNo || '';
}

function sameStage(a, b) {
  const ai = Number(a.currentIndex || 0);
  const bi = Number(b.currentIndex || 0);
  return ai === bi && a.treatments?.[ai] === b.treatments?.[bi];
}

function stampBedStageTimes(previous = {}, next = {}, now = Date.now()) {
  const byPatient = new Map();
  for (const bed of Object.values(previous)) {
    if (patientIdentity(bed) && bed.treatments?.length) byPatient.set(patientIdentity(bed), bed);
  }
  for (const [key, bed] of Object.entries(next)) {
    if (!bed?.treatments?.length || !patientIdentity(bed)) continue;
    const old = byPatient.get(patientIdentity(bed));
    let enteredAt;
    if (old && sameStage(old, bed)) {
      // Recover an outstanding completion timestamp for records created before
      // this field existed; older acknowledged completions cannot be recovered.
      const legacyCompletion = old.lastAlertId
        ? Number(String(old.lastAlertId).split('-').pop()) : 0;
      enteredAt = Number(old.stageEnteredAt) || legacyCompletion || Number(old.timestamp) || now;
    } else {
      enteredAt = now;
      // When an expired timer advances, use its actual deadline even if a
      // browser reported completion late. Manual advances use server time.
      if (old?.running && bed.lastAlertId && bed.lastAlertId !== old.lastAlertId) {
        const deadline = Number(old.startedAt) + Number(old.remaining) * 1000;
        if (Number(old.startedAt) > 0 && Number.isFinite(deadline) && deadline <= now) enteredAt = deadline;
      }
    }
    next[key] = { ...bed, stageEnteredAt: enteredAt };
  }
  return next;
}

module.exports = { stampBedStageTimes };
