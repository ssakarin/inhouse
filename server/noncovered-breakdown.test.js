const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CATEGORY_KEYS,
  buildNoncoveredBreakdown,
  classifyNoncoveredVisit,
  sheetCategoryKey
} = require("./noncovered-breakdown");

function patientWithVisit(date, entry = {}, packages = {}) {
  return { visitHistory: { [date]: entry }, packages };
}

test("uses the actual discounted amount and classifies a one-time pharma treatment", () => {
  const date = "2026-08-21";
  const visit = { noncovered_amount: 2500 };
  const patient = patientWithVisit(date, { treatments: ["약침1"] });
  assert.equal(classifyNoncoveredVisit({ patient, visit, date }), CATEGORY_KEYS.PHARMA_SINGLE);
  const result = buildNoncoveredBreakdown([{ patient_id: "p1", ...visit }], () => patient, date);
  assert.equal(result.amounts.pharmaSingle, 2500);
  assert.equal(result.totalAmount, 2500);
});

test("treats paid packages as first-payment package revenue but ignores bonus entries", () => {
  const date = "2026-08-21";
  const paid = patientWithVisit(date, { treatments: ["약침1"] }, {
    p13: { purchases: [{ date, qty: 13, kind: "purchase" }] }
  });
  const bonus = patientWithVisit(date, { treatments: ["약침1"], memo2: "약상담" }, {
    p13: { purchases: [{ date, qty: 13, kind: "bonus" }] }
  });
  assert.equal(classifyNoncoveredVisit({ patient: paid, visit: { noncovered_amount: 50000 }, date }), CATEGORY_KEYS.PHARMA_PACKAGE);
  assert.notEqual(classifyNoncoveredVisit({ patient: bonus, visit: { noncovered_amount: 300000 }, date }), CATEGORY_KEYS.PHARMA_PACKAGE);
});

test("maps configured sheet labels to canonical categories", () => {
  assert.equal(sheetCategoryKey("약침(1회성)"), CATEGORY_KEYS.PHARMA_SINGLE);
  assert.equal(sheetCategoryKey("약침패키지"), CATEGORY_KEYS.PHARMA_PACKAGE);
  assert.equal(sheetCategoryKey("경옥고,공진단"), CATEGORY_KEYS.PREMIUM_PILLS);
  assert.equal(sheetCategoryKey("기타"), CATEGORY_KEYS.OTHER);
});

test("keeps every noncovered won in the detailed total", () => {
  const date = "2026-08-21";
  const patients = {
    a: patientWithVisit(date, { treatments: ["약침1"] }),
    b: patientWithVisit(date, { treatments: ["진찰"], memo2: "린다이어트 약상담" }),
    c: patientWithVisit(date, { treatments: [] })
  };
  const visits = [
    { patient_id: "a", noncovered_amount: 5000 },
    { patient_id: "b", noncovered_amount: 470000 },
    { patient_id: "c", noncovered_amount: 12300 }
  ];
  const result = buildNoncoveredBreakdown(visits, id => patients[id], date);
  assert.equal(result.amounts.pharmaSingle, 5000);
  assert.equal(result.amounts.dietHerbal, 470000);
  assert.equal(result.amounts.other, 12300);
  assert.equal(result.totalAmount, 487300);
});
