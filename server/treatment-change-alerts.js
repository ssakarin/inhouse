const crypto = require('node:crypto');

function counts(treatments) {
  const result = new Map();
  for (const value of Array.isArray(treatments) ? treatments : []) {
    const name = String(value || '').trim();
    if (name) result.set(name, (result.get(name) || 0) + 1);
  }
  return result;
}

// Accumulate only treatment-room deltas, so intervening desk edits are excluded.
function accumulateTreatmentChange(existing, previous, next, bedNo, now = Date.now(), version = crypto.randomUUID()) {
  if (!previous?.patientKey || previous.patientKey !== next?.patientKey) return existing;
  const before = counts(previous.treatments), after = counts(next.treatments);
  const delta = new Map();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const amount = (after.get(name) || 0) - (before.get(name) || 0);
    if (amount) delta.set(name, amount);
  }
  if (!delta.size) return existing;
  const pending = existing && !existing.acknowledgedAt;
  const changes = new Map(pending ? existing.changes.map(item => [item.name, item.amount]) : []);
  for (const [name, amount] of delta) changes.set(name, (changes.get(name) || 0) + amount);
  const items = [...changes].filter(([, amount]) => amount).map(([name, amount]) => ({ name, amount }));
  if (!items.length) return null;
  return {
    patientKey: previous.patientKey, name: next.name || previous.name || '환자',
    chartNo: next.chartNo || previous.chartNo || '', bedNo: Number(bedNo),
    doctorId: next.doctorId || '', changes: items,
    timestamp: pending ? existing.timestamp : now, updatedAt: now,
    version, acknowledgedAt: null
  };
}

function acknowledgeTreatmentChange(item, version, now = Date.now()) {
  if (!item || item.acknowledgedAt || item.version !== version) return item;
  return { ...item, acknowledgedAt: now };
}

module.exports = { accumulateTreatmentChange, acknowledgeTreatmentChange };
