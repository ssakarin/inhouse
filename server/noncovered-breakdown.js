const CATEGORY_KEYS = Object.freeze({
  DEER_HERBAL: "deerHerbal",
  GENERAL_HERBAL: "generalHerbal",
  DIET_HERBAL: "dietHerbal",
  PHARMA_SINGLE: "pharmaSingle",
  PHARMA_PACKAGE: "pharmaPackage",
  PREMIUM_PILLS: "premiumPills",
  OTHER: "other"
});

// 가격표는 품목 판정의 보조 기준일 뿐이다. 실제 반영 금액은 항상
// patient_visits.noncovered_amount를 사용해 할인/추가 서비스가 그대로 보존된다.
const GENERAL_HERBAL_PRICE_ANCHORS = [
  250000, 300000, 470000, 570000, 690000, 810000, 1530000
];
const DEER_HERBAL_PRICE_ANCHORS = [
  350000, 400000, 450000, 500000, 600000, 650000, 760000, 850000,
  950000, 1080000, 1140000, 1150000, 1250000, 1350000, 1620000,
  1700000, 2040000, 2550000, 3060000
];

function normalizedText(value) {
  return String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function packageEntries(value) {
  if (Array.isArray(value)) return value;
  return Object.values(value || {});
}

function hasPaidPharmaPackagePurchase(patient = {}, date = "") {
  return Object.entries(patient.packages || {}).some(([key, pkg]) => {
    if (!String(key || "").startsWith("p")) return false;
    return packageEntries(pkg?.purchases).some(entry =>
      normalizedText(entry?.date) === date
      && normalizedText(entry?.kind).toLowerCase() !== "bonus"
      && (Number(entry?.qty ?? entry?.totalQty ?? 0) || 0) > 0
    );
  });
}

function relativeDistance(value, anchor) {
  return Math.abs(value - anchor) / Math.max(1, anchor);
}

function closestDistance(value, anchors) {
  return Math.min(...anchors.map(anchor => relativeDistance(value, anchor)));
}

function inferHerbalCategoryFromPrice(amount) {
  const value = Number(amount || 0);
  if (value <= 0) return CATEGORY_KEYS.GENERAL_HERBAL;
  const generalDistance = closestDistance(value, GENERAL_HERBAL_PRICE_ANCHORS);
  const deerDistance = closestDistance(value, DEER_HERBAL_PRICE_ANCHORS);
  // 임의 할인 때문에 작은 차이는 단정하지 않고 일반한약으로 둔다.
  return deerDistance + 0.03 < generalDistance
    ? CATEGORY_KEYS.DEER_HERBAL
    : CATEGORY_KEYS.GENERAL_HERBAL;
}

function classifyNoncoveredVisit({ patient = {}, visit = {}, date = "" } = {}) {
  const amount = Number(visit.noncovered_amount ?? visit.noncoveredAmount ?? 0) || 0;
  const entry = patient.visitHistory?.[date] || {};
  const treatments = Array.isArray(entry.treatments)
    ? entry.treatments.map(normalizedText).filter(Boolean)
    : [];
  const text = normalizedText([
    visit.chief_complaint,
    visit.diagnosis_code,
    entry.chiefComplaint,
    entry.memo2,
    ...(treatments || [])
  ].join(" "));

  if (hasPaidPharmaPackagePurchase(patient, date)) return CATEGORY_KEYS.PHARMA_PACKAGE;
  if (/다이어트|린다이어트/.test(text)) return CATEGORY_KEYS.DIET_HERBAL;
  if (/경옥고|공진단/.test(text)) return CATEGORY_KEYS.PREMIUM_PILLS;
  if (/녹용|상대|분골|기름분골/.test(text)) return CATEGORY_KEYS.DEER_HERBAL;

  const hasPharmaTreatment = treatments.some(treatment => treatment.includes("약침"));
  const hasHerbalContext = /처방|약상담|한약/.test(text)
    || normalizedText(visit.diagnosis_code) === "ZZ00";
  if (hasHerbalContext) return inferHerbalCategoryFromPrice(amount);
  if (hasPharmaTreatment) return CATEGORY_KEYS.PHARMA_SINGLE;

  // 진료 메모가 비어 있어도 가격표의 한약 가격대와 매우 가까운 큰 금액은
  // 녹용한약으로만 제한적으로 추정하고, 그 외에는 기타로 남긴다.
  if (amount >= 150000) {
    const deerDistance = closestDistance(amount, DEER_HERBAL_PRICE_ANCHORS);
    const generalDistance = closestDistance(amount, GENERAL_HERBAL_PRICE_ANCHORS);
    if (deerDistance <= 0.02 && deerDistance + 0.03 < generalDistance) {
      return CATEGORY_KEYS.DEER_HERBAL;
    }
  }
  return CATEGORY_KEYS.OTHER;
}

function sheetCategoryKey(label) {
  const text = normalizedText(label).replace(/[_\s]/g, "");
  if (!text) return "";
  if (text.includes("녹용") && text.includes("한약")) return CATEGORY_KEYS.DEER_HERBAL;
  if (text.includes("다이어트") && text.includes("한약")) return CATEGORY_KEYS.DIET_HERBAL;
  if (text.includes("약침") && text.includes("패키지")) return CATEGORY_KEYS.PHARMA_PACKAGE;
  if (text.includes("약침")) return CATEGORY_KEYS.PHARMA_SINGLE;
  if (text.includes("경옥고") || text.includes("공진단")) return CATEGORY_KEYS.PREMIUM_PILLS;
  if (text.includes("일반") && text.includes("한약")) return CATEGORY_KEYS.GENERAL_HERBAL;
  if (text === "기타" || text.startsWith("기타")) return CATEGORY_KEYS.OTHER;
  return "";
}

function buildNoncoveredBreakdown(visits = [], getPatient = () => null, date = "") {
  const amounts = Object.fromEntries(Object.values(CATEGORY_KEYS).map(key => [key, 0]));
  const visitCounts = Object.fromEntries(Object.values(CATEGORY_KEYS).map(key => [key, 0]));
  for (const visit of visits) {
    const amount = Number(visit?.noncovered_amount ?? visit?.noncoveredAmount ?? 0) || 0;
    if (amount <= 0) continue;
    const patient = getPatient(visit.patient_id) || {};
    const category = classifyNoncoveredVisit({ patient, visit, date });
    amounts[category] += amount;
    visitCounts[category] += 1;
  }
  return {
    amounts,
    visitCounts,
    totalAmount: Object.values(amounts).reduce((sum, amount) => sum + amount, 0),
    visitCount: Object.values(visitCounts).reduce((sum, count) => sum + count, 0)
  };
}

module.exports = {
  CATEGORY_KEYS,
  buildNoncoveredBreakdown,
  classifyNoncoveredVisit,
  sheetCategoryKey
};
