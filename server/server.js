const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { encrypt, decrypt, isEncrypted, KEY_PATH } = require("./crypto-util");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const BACKUP_DIR = path.join(__dirname, "backups");
const SLACK_BACKUP_DIR = path.join(ROOT_DIR, "slack_backups");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "clinic.db");
const GOOGLE_SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT_DIR, "..", "3rd_visit_check", "service_account.json");
const THIRD_VISIT_SPREADSHEET_ID = process.env.THIRD_VISIT_SPREADSHEET_ID || "15gFBhgjPRiQpno5Q-LmAlB1SbvyP_VNrYTLpD7lhuy4";
const THIRD_VISIT_WORKSHEET_INDEX = Number(process.env.THIRD_VISIT_WORKSHEET_INDEX || 1);

// Login password (gates every page and API) and the delete-all confirmation
// password. Both are read from env so they are not hardcoded; defaults keep the
// app working on first run but should be overridden in production.
const LOGIN_PASSWORD = process.env.CLINIC_PASSWORD || "7677";
const DELETE_PASSWORD = process.env.CLINIC_DELETE_PASSWORD || "337758";
const SLACK_TOKEN = process.env.SLACK_TOKEN || "";
const ONLINE_MANAGEMENT_SLACK_CHANNEL = process.env.ONLINE_MANAGEMENT_SLACK_CHANNEL || "\uC628\uB77C\uC778\uAD00\uB9AC";
const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365; // 1 year — enter once per device

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(SLACK_BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
const stateValueCache = new Map();
let patientCache = null;
let patientChartIndex = null;
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS patients (
    patient_id TEXT PRIMARY KEY,
    chart_no TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_state (
    state_key TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS patient_visits (
    patient_id TEXT NOT NULL,
    chart_no TEXT NOT NULL,
    visit_date TEXT NOT NULL,
    doctor_name TEXT,
    visit_type TEXT,
    chief_complaint TEXT,
    PRIMARY KEY (patient_id, visit_date)
  );
  CREATE INDEX IF NOT EXISTS idx_patients_chart_no ON patients (chart_no);
  CREATE INDEX IF NOT EXISTS idx_patients_name ON patients (name);
  CREATE INDEX IF NOT EXISTS idx_patient_visits_date ON patient_visits (visit_date);
  CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor ON patient_visits (doctor_name);
  CREATE INDEX IF NOT EXISTS idx_patient_visits_chart_no ON patient_visits (chart_no);
`);

function readMaybeEncryptedJson(raw) {
  return JSON.parse(isEncrypted(raw) ? decrypt(raw) : raw);
}

function encryptedJson(value) {
  return encrypt(JSON.stringify(value));
}

function normalizePatientName(value) {
  return normalizeSearchText(value).replace(/\s+/g, " ");
}

function makeDuplicatePatientId(chartNo, name) {
  const hash = crypto.createHash("sha1").update(`${chartNo}\0${normalizePatientName(name)}`).digest("hex").slice(0, 10);
  return `${chartNo}__${hash}`;
}

function patientIdForMigratedRow(chartNo, record = {}) {
  return normalizeSearchText(record.patientId || record.patient_id || chartNo);
}

function ensurePatientIdentitySchema() {
  const patientColumns = new Set(db.prepare("PRAGMA table_info(patients)").all().map(column => column.name));
  if (!patientColumns.has("patient_id")) {
    db.exec("ALTER TABLE patients RENAME TO patients_legacy");
    db.exec(`
      CREATE TABLE patients (
        patient_id TEXT PRIMARY KEY,
        chart_no TEXT NOT NULL,
        name TEXT,
        phone TEXT,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patients_chart_no ON patients (chart_no);
      CREATE INDEX IF NOT EXISTS idx_patients_name ON patients (name);
    `);
    const legacyRows = db.prepare("SELECT chart_no, name, phone, data_json, updated_at FROM patients_legacy").all();
    const insert = db.prepare(`
      INSERT INTO patients (patient_id, chart_no, name, phone, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    try {
      for (const row of legacyRows) {
        const chartNo = normalizeChartNo(row.chart_no);
        if (!chartNo) continue;
        const record = readMaybeEncryptedJson(row.data_json);
        const patientId = patientIdForMigratedRow(chartNo, record);
        const normalized = { ...record, patientId, chartNo };
        insert.run(
          patientId,
          chartNo,
          normalizeSearchText(normalized.name || row.name),
          getPatientPhone(normalized) || normalizeSearchText(row.phone),
          encryptedJson(normalized),
          row.updated_at || new Date().toISOString()
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.exec("DROP TABLE patients_legacy");
  }

  const visitColumns = new Set(db.prepare("PRAGMA table_info(patient_visits)").all().map(column => column.name));
  if (!visitColumns.has("patient_id")) {
    db.exec("ALTER TABLE patient_visits RENAME TO patient_visits_legacy");
    db.exec(`
      CREATE TABLE patient_visits (
        patient_id TEXT NOT NULL,
        chart_no TEXT NOT NULL,
        visit_date TEXT NOT NULL,
        doctor_name TEXT,
        visit_type TEXT,
        chief_complaint TEXT,
        PRIMARY KEY (patient_id, visit_date)
      );
      CREATE INDEX IF NOT EXISTS idx_patient_visits_date ON patient_visits (visit_date);
      CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor ON patient_visits (doctor_name);
      CREATE INDEX IF NOT EXISTS idx_patient_visits_chart_no ON patient_visits (chart_no);
    `);
    const rows = db.prepare("SELECT chart_no, visit_date, doctor_name, visit_type, chief_complaint FROM patient_visits_legacy").all();
    const chartToPatient = new Map(db.prepare("SELECT patient_id, chart_no FROM patients").all().map(row => [normalizeChartNo(row.chart_no), row.patient_id]));
    const insert = db.prepare(`
      INSERT OR REPLACE INTO patient_visits (patient_id, chart_no, visit_date, doctor_name, visit_type, chief_complaint)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const chartNo = normalizeChartNo(row.chart_no);
        const patientId = chartToPatient.get(chartNo);
        if (!chartNo || !patientId) continue;
        insert.run(patientId, chartNo, row.visit_date, row.doctor_name, row.visit_type, row.chief_complaint);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.exec("DROP TABLE patient_visits_legacy");
  }
}

ensurePatientIdentitySchema();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_patients_chart_no ON patients (chart_no);
  CREATE INDEX IF NOT EXISTS idx_patients_name ON patients (name);
  CREATE INDEX IF NOT EXISTS idx_patient_visits_date ON patient_visits (visit_date);
  CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor ON patient_visits (doctor_name);
  CREATE INDEX IF NOT EXISTS idx_patient_visits_chart_no ON patient_visits (chart_no);
`);

function ensurePatientSearchColumns() {
  const columns = new Set(db.prepare("PRAGMA table_info(patients)").all().map(column => column.name));
  if (!columns.has("patient_id")) throw new Error("patients.patient_id migration failed");
  if (!columns.has("chart_no")) db.exec("ALTER TABLE patients ADD COLUMN chart_no TEXT");
  if (!columns.has("name")) db.exec("ALTER TABLE patients ADD COLUMN name TEXT");
  if (!columns.has("phone")) db.exec("ALTER TABLE patients ADD COLUMN phone TEXT");
}

ensurePatientSearchColumns();

const statements = {
  listPatients: db.prepare("SELECT patient_id, data_json FROM patients ORDER BY chart_no COLLATE NOCASE, name COLLATE NOCASE, patient_id"),
  countPatients: db.prepare("SELECT COUNT(*) AS count FROM patients"),
  searchPatients: db.prepare(`
    SELECT patient_id, data_json FROM patients
    WHERE chart_no LIKE ? ESCAPE '\\'
       OR name LIKE ? ESCAPE '\\'
       OR phone LIKE ? ESCAPE '\\'
    ORDER BY chart_no COLLATE NOCASE, name COLLATE NOCASE, patient_id
    LIMIT ?
  `),
  getPatientById: db.prepare("SELECT patient_id, data_json FROM patients WHERE patient_id = ?"),
  listPatientsByChartNo: db.prepare("SELECT patient_id, data_json FROM patients WHERE chart_no = ? ORDER BY name COLLATE NOCASE, patient_id"),
  findPatientByChartName: db.prepare("SELECT patient_id, data_json FROM patients WHERE chart_no = ? AND name = ? ORDER BY patient_id LIMIT 1"),
  upsertPatient: db.prepare(`
    INSERT INTO patients (patient_id, chart_no, name, phone, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(patient_id) DO UPDATE SET
      chart_no = excluded.chart_no,
      name = excluded.name,
      phone = excluded.phone,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `),
  deletePatient: db.prepare("DELETE FROM patients WHERE patient_id = ?"),
  deleteAllPatients: db.prepare("DELETE FROM patients"),
  deletePatientVisits: db.prepare("DELETE FROM patient_visits WHERE patient_id = ?"),
  deleteAllPatientVisits: db.prepare("DELETE FROM patient_visits"),
  upsertPatientVisit: db.prepare(`
    INSERT INTO patient_visits (patient_id, chart_no, visit_date, doctor_name, visit_type, chief_complaint)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(patient_id, visit_date) DO UPDATE SET
      chart_no = excluded.chart_no,
      doctor_name = excluded.doctor_name,
      visit_type = excluded.visit_type,
      chief_complaint = excluded.chief_complaint
  `),
  listVisitChartNosByMonth: db.prepare(`
    SELECT
      pv.patient_id,
      pv.chart_no,
      pv.visit_date,
      pv.doctor_name,
      pv.visit_type,
      pv.chief_complaint,
      p.name,
      p.phone
    FROM patient_visits pv
    LEFT JOIN patients p ON p.patient_id = pv.patient_id
    WHERE pv.visit_date >= ? AND pv.visit_date <= ?
    ORDER BY pv.visit_date, pv.chart_no COLLATE NOCASE, p.name COLLATE NOCASE, pv.patient_id
  `),
  listVisitsAfterDate: db.prepare(`
    SELECT
      pv.patient_id,
      pv.chart_no,
      pv.visit_date,
      pv.doctor_name,
      pv.visit_type,
      pv.chief_complaint,
      p.name
    FROM patient_visits pv
    LEFT JOIN patients p ON p.patient_id = pv.patient_id
    WHERE pv.visit_date > ?
    ORDER BY pv.visit_date, pv.chart_no COLLATE NOCASE, p.name COLLATE NOCASE, pv.patient_id
  `),
  getState: db.prepare("SELECT data_json FROM app_state WHERE state_key = ?"),
  upsertState: db.prepare(`
    INSERT INTO app_state (state_key, data_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `),
  deleteState: db.prepare("DELETE FROM app_state WHERE state_key = ?")
};

// One-time migration: encrypt any rows still stored as plaintext (data written
// before encryption-at-rest was enabled). Runs every startup but is a no-op once
// everything is encrypted, since isEncrypted() skips already-encrypted rows.
function migrateEncryptAtRest() {
  const patientRows = db.prepare("SELECT patient_id, chart_no, data_json FROM patients").all();
  const stateRows = db.prepare("SELECT state_key, data_json FROM app_state").all();
  const updatePatient = db.prepare("UPDATE patients SET data_json = ? WHERE patient_id = ?");
  const updateState = db.prepare("UPDATE app_state SET data_json = ? WHERE state_key = ?");
  let migrated = 0;
  db.exec("BEGIN");
  try {
    for (const row of patientRows) {
      if (!isEncrypted(row.data_json)) {
        const record = readMaybeEncryptedJson(row.data_json);
        updatePatient.run(encryptedJson({ ...record, patientId: row.patient_id, chartNo: normalizeChartNo(record.chartNo || row.chart_no) }), row.patient_id);
        migrated += 1;
      }
    }
    for (const row of stateRows) {
      if (!isEncrypted(row.data_json)) {
        updateState.run(encrypt(row.data_json), row.state_key);
        migrated += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (migrated) console.log(`[crypto] Encrypted ${migrated} plaintext row(s) at rest`);
}

migrateEncryptAtRest();

function backfillPatientSearchColumns() {
  const rows = db.prepare("SELECT patient_id, chart_no, name, phone, data_json FROM patients WHERE name IS NULL OR phone IS NULL").all();
  if (!rows.length) return;
  const update = db.prepare("UPDATE patients SET name = ?, phone = ? WHERE patient_id = ?");
  let updated = 0;
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const record = JSON.parse(decrypt(row.data_json));
      update.run(normalizeSearchText(record.name), getPatientPhone(record), row.patient_id);
      updated += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (updated) console.log(`[db] Backfilled search columns for ${updated} patient row(s)`);
}

backfillPatientSearchColumns();
ensurePatientVisitIndex();
ensurePatientCache();

function normalizeChartNo(value) {
  return String(value || "").trim().replace(/\.0$/, "");
}

function normalizeSearchText(value) {
  return String(value || "").trim();
}

function getPatientPhone(record = {}) {
  return normalizeSearchText(record.phone || record.phoneNumber || record.tel || record.mobile || record.contact);
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, match => `\\${match}`);
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function textResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

const DEFAULT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
const LARGE_BODY_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

function readBody(req, maxBytes = DEFAULT_BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const limitMb = Math.round(maxBytes / 1024 / 1024);
        reject(new Error(`Request body too large; limit is ${limitMb}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : null;
}

function parsePatientRow(row) {
  const record = JSON.parse(decrypt(row.data_json));
  return {
    ...record,
    patientId: record.patientId || row.patient_id || record.chartNo,
    chartNo: normalizeChartNo(record.chartNo)
  };
}

function patientSort(a, b) {
  return normalizeChartNo(a.chartNo).localeCompare(normalizeChartNo(b.chartNo), "ko", { numeric: true })
    || normalizeSearchText(a.name).localeCompare(normalizeSearchText(b.name), "ko")
    || normalizeSearchText(a.patientId).localeCompare(normalizeSearchText(b.patientId), "ko");
}

function indexCachedPatient(record) {
  if (!patientCache || !patientChartIndex || !record?.patientId) return;
  const previous = patientCache.get(record.patientId);
  if (previous?.chartNo) {
    const oldChartNo = normalizeChartNo(previous.chartNo);
    const oldIds = patientChartIndex.get(oldChartNo);
    if (oldIds) {
      oldIds.delete(record.patientId);
      if (!oldIds.size) patientChartIndex.delete(oldChartNo);
    }
  }
  patientCache.set(record.patientId, record);
  const chartNo = normalizeChartNo(record.chartNo);
  if (!patientChartIndex.has(chartNo)) patientChartIndex.set(chartNo, new Set());
  patientChartIndex.get(chartNo).add(record.patientId);
}

function removeCachedPatient(patientId) {
  if (!patientCache || !patientChartIndex) return;
  const normalizedId = normalizeSearchText(patientId);
  const previous = patientCache.get(normalizedId);
  if (previous?.chartNo) {
    const ids = patientChartIndex.get(normalizeChartNo(previous.chartNo));
    if (ids) {
      ids.delete(normalizedId);
      if (!ids.size) patientChartIndex.delete(normalizeChartNo(previous.chartNo));
    }
  }
  patientCache.delete(normalizedId);
}

function clearPatientCache() {
  patientCache = new Map();
  patientChartIndex = new Map();
}

function invalidatePatientCache() {
  patientCache = null;
  patientChartIndex = null;
}

function ensurePatientCache() {
  if (patientCache && patientChartIndex) return;
  patientCache = new Map();
  patientChartIndex = new Map();
  for (const row of statements.listPatients.all()) {
    indexCachedPatient(parsePatientRow(row));
  }
  console.log(`[db] Loaded ${patientCache.size} patient row(s) into memory cache`);
}

function listPatients() {
  ensurePatientCache();
  return [...patientCache.values()].sort(patientSort);
}

function countPatients() {
  if (patientCache) return patientCache.size;
  return Number(statements.countPatients.get()?.count || 0);
}

function searchPatients(query, limit = 50) {
  const q = normalizeSearchText(query);
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)));
  ensurePatientCache();
  return [...patientCache.values()]
    .filter(record =>
      normalizeChartNo(record.chartNo).includes(q)
      || normalizeSearchText(record.name).includes(q)
      || getPatientPhone(record).includes(q)
    )
    .sort(patientSort)
    .slice(0, safeLimit);
}

function visitEntriesFromRecord(record = {}) {
  const dates = Array.isArray(record.visitDates) ? record.visitDates.map(String) : [];
  Object.keys(record.visitHistory || {}).forEach(date => dates.push(String(date)));
  return [...new Set(dates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))]
    .sort()
    .map(date => {
      const entry = record.visitHistory?.[date] || {};
      return {
        date,
        doctorName: normalizeSearchText(entry.doctorName || record.doctorName),
        visitType: normalizeSearchText(entry.visitType || record.visitType),
        chiefComplaint: normalizeSearchText(entry.chiefComplaint || record.chiefComplaint)
      };
    });
}

function syncPatientVisitIndex(record = {}) {
  const chartNo = normalizeChartNo(record?.chartNo);
  const patientId = normalizeSearchText(record?.patientId || chartNo);
  if (!chartNo || !patientId) return;
  statements.deletePatientVisits.run(patientId);
  for (const entry of visitEntriesFromRecord(record)) {
    statements.upsertPatientVisit.run(patientId, chartNo, entry.date, entry.doctorName, entry.visitType, entry.chiefComplaint);
  }
}

function rebuildPatientVisitIndex() {
  const rows = statements.listPatients.all();
  statements.deleteAllPatientVisits.run();
  for (const row of rows) {
    syncPatientVisitIndex(parsePatientRow(row));
  }
  if (rows.length) console.log(`[db] Rebuilt visit index for ${rows.length} patient row(s)`);
}

function ensurePatientVisitIndex() {
  const patientCount = countPatients();
  const visitCount = Number(db.prepare("SELECT COUNT(*) AS count FROM patient_visits").get()?.count || 0);
  if (patientCount && !visitCount) rebuildPatientVisitIndex();
}

function patientsByVisitMonth(month) {
  const normalizedMonth = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) throw new Error("month must be YYYY-MM");
  const [year, rawMonth] = normalizedMonth.split("-").map(Number);
  const start = `${normalizedMonth}-01`;
  const end = `${normalizedMonth}-${String(new Date(year, rawMonth, 0).getDate()).padStart(2, "0")}`;
  const counts = {};
  const patientsById = new Map();
  for (const row of statements.listVisitChartNosByMonth.all(start, end)) {
    counts[row.visit_date] = (counts[row.visit_date] || 0) + 1;
    const chartNo = normalizeChartNo(row.chart_no);
    const patientId = normalizeSearchText(row.patient_id || chartNo);
    if (!chartNo || !patientId) continue;
    const patient = patientsById.get(patientId) || {
      patientId,
      chartNo,
      name: row.name || "",
      phone: row.phone || "",
      visitDates: [],
      visitHistory: {}
    };
    if (!patient.visitDates.includes(row.visit_date)) patient.visitDates.push(row.visit_date);
    patient.visitHistory[row.visit_date] = {
      doctorName: row.doctor_name || "",
      visitType: row.visit_type || "",
      chiefComplaint: row.chief_complaint || ""
    };
    patientsById.set(patientId, patient);
  }
  const records = [...patientsById.values()];
  records.sort((a, b) => normalizeChartNo(a.chartNo).localeCompare(normalizeChartNo(b.chartNo), "ko", { numeric: true }));
  return { month: normalizedMonth, counts, patients: records };
}

function ymd(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function visitDatesOf(record = {}) {
  const dates = Array.isArray(record.visitDates) ? record.visitDates.map(String) : [];
  Object.keys(record.visitHistory || {}).forEach(date => dates.push(String(date)));
  return [...new Set(dates.filter(Boolean))].sort();
}

function isPrescriptionChiefComplaint(value) {
  const text = String(value || "").trim().replace(/\s+/g, "");
  return text === "처방" || text === "-처방-";
}

function isPrescriptionVisit(record = {}, date) {
  const history = record.visitHistory || {};
  if (Object.prototype.hasOwnProperty.call(history, date)) {
    return isPrescriptionChiefComplaint(history[date]?.chiefComplaint);
  }
  return isPrescriptionChiefComplaint(record.chiefComplaint);
}

function normalizeVisitType(value) {
  const text = String(value || "").trim().replace(/\s+/g, "");
  if (text.includes("초진")) return "초진";
  if (text.includes("재진")) return "재진";
  return "";
}

function getVisitRecord(record = {}, date) {
  return (record.visitHistory || {})[date] || {};
}

function explicitNewVisitDatesOf(record = {}) {
  return visitDatesOf(record).filter(date => normalizeVisitType(getVisitRecord(record, date).visitType) === "초진");
}

function newVisitDatesOf(record = {}) {
  const explicitDates = explicitNewVisitDatesOf(record);
  if (explicitDates.length) return explicitDates;
  const dates = visitDatesOf(record);
  return dates.length ? [dates[0]] : [];
}

function nonPrescriptionVisitDatesOf(record = {}) {
  return visitDatesOf(record).filter(date => !isPrescriptionVisit(record, date));
}

function visitsWithinDays(dates, startDate, days) {
  const endDate = addDays(startDate, days - 1);
  return dates.filter(date => date >= startDate && date <= endDate).length;
}

function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const weekYear = d.getFullYear();
  const week1 = new Date(weekYear, 0, 4);
  const weekNo = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${weekYear}${String(weekNo).padStart(2, "0")}`;
}

function periodKey(dateStr, unit = "week") {
  const d = new Date(`${dateStr}T00:00:00`);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (unit === "day") return dateStr.replaceAll("-", "");
  if (unit === "month") return `${year}${String(month).padStart(2, "0")}`;
  if (unit === "quarter") return `${year}Q${Math.ceil(month / 3)}`;
  if (unit === "year") return String(year);
  return isoWeekKey(dateStr);
}

function normalizeTreatmentStatName(name) {
  const text = String(name || "").trim();
  if (text === "추나" || text === "단추") return "단순추나";
  if (text === "복추") return "복잡추나";
  return text;
}

function collectStatsDoctors() {
  return db.prepare(`
    SELECT DISTINCT doctor_name AS doctorName
    FROM patient_visits
    WHERE doctor_name IS NOT NULL AND TRIM(doctor_name) <> ''
    ORDER BY doctor_name COLLATE NOCASE
  `).all().map(row => row.doctorName);
}

function noFollowupNewPatientsFromRecords(records, docFilter = "") {
  const todayStr = ymd(new Date());
  const targetDates = new Map(Array.from({ length: 14 }, (_, index) => 20 - index).map(daysAgo => [addDays(todayStr, -daysAgo), daysAgo]));
  const rows = [];
  for (const record of records) {
    const dates = visitDatesOf(record).filter(date => date <= todayStr);
    if (!dates.length) continue;
    for (const firstDate of newVisitDatesOf(record).filter(date => date <= todayStr)) {
      if (!targetDates.has(firstDate)) continue;
      const firstEntry = getVisitRecord(record, firstDate);
      if (isPrescriptionVisit(record, firstDate)) continue;
      const doctorName = normalizeSearchText(firstEntry.doctorName || record.doctorName);
      if (docFilter && doctorName !== docFilter) continue;
      if (dates.some(date => date > firstDate && date <= todayStr)) continue;
      rows.push({
        chartNo: record.chartNo || "",
        name: record.name || "",
        firstDate,
        daysAgo: targetDates.get(firstDate),
        doctorName,
        age: record.age || "",
        gender: record.gender || "",
        phone: record.phone || record.phoneNumber || record.tel || ""
      });
    }
  }
  return rows.sort((a, b) => b.daysAgo - a.daysAgo || String(a.chartNo).localeCompare(String(b.chartNo), "ko", { numeric: true }));
}

function computeClinicStats({ start, end, docFilter = "", chartUnit = "week" }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(end || "")) {
    throw new Error("start and end must be YYYY-MM-DD");
  }
  const records = listPatients();
  const inRange = date => date >= start && date <= end;
  const patientSet = new Set();
  const prescriptionPatientSet = new Set();
  const newPatientSet = new Set();
  let visits = 0;
  let coreVisits = 0;
  let newPatients = 0;
  let returningPatients = 0;
  let thirdVisitPatients = 0;
  const treatmentCounts = {};
  let pharmaTotal = 0;
  const doctorCounts = {};
  const weekdayCounts = {};
  const weekdayDateSets = {};
  const treatmentComboCounts = {};
  const trendBuckets = {};
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];

  for (const record of records) {
    const dates = visitDatesOf(record);
    if (!dates.length) continue;
    const pid = String(record.patientId || record.chartNo || record.name || "");
    if (!pid) continue;
    let matchedCore = false;

    for (const date of dates.filter(inRange)) {
      const entry = getVisitRecord(record, date);
      const doctorName = normalizeSearchText(entry.doctorName || record.doctorName);
      if (docFilter && doctorName !== docFilter) continue;
      const isPrescription = isPrescriptionVisit(record, date);
      visits += 1;
      const treatments = Array.isArray(entry.treatments) ? entry.treatments : [];
      const weekday = weekdays[new Date(`${date}T00:00:00`).getDay()];
      weekdayCounts[weekday] = (weekdayCounts[weekday] || 0) + 1;
      if (!weekdayDateSets[weekday]) weekdayDateSets[weekday] = new Set();
      weekdayDateSets[weekday].add(date);
      const key = periodKey(date, chartUnit);
      if (!trendBuckets[key]) {
        trendBuckets[key] = {
          key,
          visits: 0,
          coreVisits: 0,
          newPatients: 0,
          returningPatients: 0,
          thirdVisitPatients: 0,
          patientIds: new Set(),
          prescriptionPatientIds: new Set(),
          dates: new Set()
        };
      }
      trendBuckets[key].visits += 1;
      trendBuckets[key].dates.add(date);
      if (isPrescription) {
        prescriptionPatientSet.add(pid);
        trendBuckets[key].prescriptionPatientIds.add(pid);
      } else {
        matchedCore = true;
        coreVisits += 1;
        trendBuckets[key].coreVisits += 1;
        trendBuckets[key].patientIds.add(pid);
      }
      let countedPharma = false;
      const comboParts = [];
      for (const rawTreatment of treatments) {
        const treatment = normalizeTreatmentStatName(rawTreatment);
        if (!treatment) continue;
        treatmentCounts[treatment] = (treatmentCounts[treatment] || 0) + 1;
        comboParts.push(treatment);
        if (treatment.includes("약침") && !countedPharma) {
          pharmaTotal += 1;
          countedPharma = true;
        }
      }
      const combo = [...new Set(comboParts)].sort((a, b) => a.localeCompare(b, "ko")).join(" + ");
      if (combo) treatmentComboCounts[combo] = (treatmentComboCounts[combo] || 0) + 1;
      if (doctorName) doctorCounts[doctorName] = (doctorCounts[doctorName] || 0) + 1;
    }

    if (matchedCore) patientSet.add(pid);

    for (const firstDate of newVisitDatesOf(record)) {
      if (!inRange(firstDate) || isPrescriptionVisit(record, firstDate)) continue;
      const firstDoctor = normalizeSearchText(getVisitRecord(record, firstDate).doctorName || record.doctorName);
      if (docFilter && firstDoctor !== docFilter) continue;
      newPatients += 1;
      newPatientSet.add(pid);
      const nonPrescriptionDates = nonPrescriptionVisitDatesOf(record);
      const followupVisitCount = visitsWithinDays(nonPrescriptionDates, firstDate, 21);
      const isReturning = followupVisitCount >= 2;
      const isThirdVisit = followupVisitCount >= 3;
      if (isReturning) returningPatients += 1;
      if (isThirdVisit) thirdVisitPatients += 1;
      const key = periodKey(firstDate, chartUnit);
      if (trendBuckets[key]) {
        trendBuckets[key].newPatients += 1;
        if (isReturning) trendBuckets[key].returningPatients += 1;
        if (isThirdVisit) trendBuckets[key].thirdVisitPatients += 1;
      }
    }
  }

  Object.keys(weekdayCounts).forEach(day => {
    const clinicDays = Math.max(1, weekdayDateSets[day]?.size || 0);
    weekdayCounts[day] = weekdayCounts[day] / clinicDays;
  });

  const trendStats = Object.values(trendBuckets)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(bucket => {
      const clinicDays = Math.max(1, bucket.dates.size);
      return {
        key: bucket.key,
        clinicDays,
        visits: bucket.visits,
        newPatients: bucket.newPatients,
        returningPatients: bucket.returningPatients,
        thirdVisitPatients: bucket.thirdVisitPatients,
        avgVisitsPerDay: bucket.coreVisits / clinicDays,
        avgNewPatientsPerDay: bucket.newPatients / clinicDays,
        avgPrescriptionPatientsPerDay: bucket.prescriptionPatientIds.size / clinicDays,
        returnRate: bucket.newPatients ? bucket.returningPatients / bucket.newPatients : 0,
        thirdVisitRate: bucket.newPatients ? bucket.thirdVisitPatients / bucket.newPatients : 0
      };
    });

  return {
    recordCount: records.length,
    uniquePatients: patientSet.size,
    totalPatients: patientSet.size + prescriptionPatientSet.size,
    visits,
    coreVisits,
    prescriptionPatients: prescriptionPatientSet.size,
    newPatients,
    revisitPatients: Math.max(0, patientSet.size - newPatientSet.size),
    returnRate: newPatients ? returningPatients / newPatients : 0,
    thirdVisitRate: newPatients ? thirdVisitPatients / newPatients : 0,
    avgVisitsPerPatient: patientSet.size ? coreVisits / patientSet.size : 0,
    pharmaTotal,
    treatmentCounts,
    doctorCounts,
    weekdayCounts,
    treatmentComboCounts,
    trendStats,
    noFollowupRows: noFollowupNewPatientsFromRecords(records, docFilter)
  };
}

function getPatientById(patientId) {
  ensurePatientCache();
  return patientCache.get(normalizeSearchText(patientId)) || null;
}

function getPatientsByChartNo(chartNo) {
  const normalized = normalizeChartNo(chartNo);
  if (!normalized) return [];
  ensurePatientCache();
  return [...(patientChartIndex.get(normalized) || [])]
    .map(patientId => patientCache.get(patientId))
    .filter(Boolean)
    .sort(patientSort);
}

function getPatient(chartNo) {
  return getPatientsByChartNo(chartNo)[0] || null;
}

function getPatients(chartNos) {
  const records = [];
  for (const chartNo of chartNos) {
    const normalized = normalizeChartNo(chartNo);
    if (!normalized) continue;
    records.push(...getPatientsByChartNo(normalized));
  }
  return records;
}

function resolvePatientId(record = {}) {
  const chartNo = normalizeChartNo(record?.chartNo);
  if (!chartNo) throw new Error("chartNo is required");
  const requestedId = normalizeSearchText(record.patientId || record.patient_id);
  if (requestedId) return requestedId;

  const name = normalizeSearchText(record.name);
  if (name) {
    const sameName = getPatientsByChartNo(chartNo).find(patient => normalizeSearchText(patient.name) === name);
    if (sameName?.patientId) return sameName.patientId;
  }

  const existing = getPatientsByChartNo(chartNo);
  if (!existing.length) return chartNo;
  if (!name && existing.length === 1) return existing[0].patientId;
  return makeDuplicatePatientId(chartNo, name || `unknown-${Date.now()}`);
}

function savePatient(record) {
  const chartNo = normalizeChartNo(record?.chartNo);
  if (!chartNo) throw new Error("chartNo is required");
  const patientId = resolvePatientId(record);
  const now = new Date().toISOString();
  const normalized = { ...record, patientId, chartNo };
  statements.upsertPatient.run(
    patientId,
    chartNo,
    normalizeSearchText(normalized.name),
    getPatientPhone(normalized),
    encrypt(JSON.stringify(normalized)),
    now
  );
  syncPatientVisitIndex(normalized);
  indexCachedPatient(normalized);
  return normalized;
}

function encryptedPatientBackup(records, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // .json.enc signals the file is AES-256-GCM encrypted, not plain JSON.
  // Decrypt with: node server/decrypt-backup.js <file.json.enc> [out.json]
  const file = path.join(BACKUP_DIR, `patients-${reason}-${stamp}.json.enc`);
  const body = encrypt(JSON.stringify(records, null, 2));
  fs.writeFileSync(file, body, "utf8");
  return { file, body };
}

function backupPatients(records, reason) {
  const { file } = encryptedPatientBackup(records, reason);
  return file;
}

function parseBackupTimestampFromName(name) {
  const match = name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/);
  if (!match) return null;
  const [, day, hh, mm, ss, ms = "000"] = match;
  const date = new Date(`${day}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pruneSlackTextBackups(retentionDays = 1095) {
  if (!fs.existsSync(SLACK_BACKUP_DIR)) return { scanned: 0, deleted: 0, deletes: [] };
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const deletes = [];
  const files = fs.readdirSync(SLACK_BACKUP_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isFile() && /^slack-text-backup-.*\.txt$/i.test(dirent.name));
  for (const dirent of files) {
    const filePath = path.join(SLACK_BACKUP_DIR, dirent.name);
    const time = parseBackupTimestampFromName(dirent.name) || fs.statSync(filePath).mtime;
    if (now - time.getTime() <= retentionMs) continue;
    fs.unlinkSync(filePath);
    deletes.push(dirent.name);
  }
  return { scanned: files.length, deleted: deletes.length, deletes };
}

async function slackApi(method, params = {}) {
  if (!SLACK_TOKEN) throw new Error("SLACK_TOKEN 환경변수가 설정되지 않았습니다.");
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  });
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
    },
    body
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Slack API ${method} 실패: ${data?.error || response.status}`);
  }
  return data;
}

async function listSlackChannels() {
  const channels = [];
  let cursor = "";
  do {
    const data = await slackApi("conversations.list", {
      types: "public_channel",
      exclude_archived: false,
      limit: 1000,
      cursor
    });
    channels.push(...(Array.isArray(data.channels) ? data.channels : []));
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return channels;
}

async function listSlackChannelsByTypes(types) {
  const channels = [];
  let cursor = "";
  do {
    const data = await slackApi("conversations.list", {
      types,
      exclude_archived: false,
      limit: 1000,
      cursor
    });
    channels.push(...(Array.isArray(data.channels) ? data.channels : []));
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return channels;
}

function normalizeSlackChannelName(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

async function findSlackChannelByName(channelName) {
  const target = normalizeSlackChannelName(channelName);
  const publicChannels = await listSlackChannels();
  const foundPublic = publicChannels.find(channel => normalizeSlackChannelName(channel.name) === target);
  if (foundPublic) return foundPublic;

  try {
    const privateChannels = await listSlackChannelsByTypes("private_channel");
    return privateChannels.find(channel => normalizeSlackChannelName(channel.name) === target) || null;
  } catch {
    return null;
  }
}

async function readSlackChannelMessages(channelId, options = {}) {
  const messages = [];
  let cursor = "";
  do {
    const data = await slackApi("conversations.history", {
      channel: channelId,
      limit: 1000,
      cursor,
      oldest: options.oldest,
      latest: options.latest,
      inclusive: options.inclusive
    });
    messages.push(...(Array.isArray(data.messages) ? data.messages : []));
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return messages;
}

function formatSlackTimestamp(ts) {
  const seconds = Number.parseFloat(ts || "0");
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const date = new Date(seconds * 1000);
  return ymd(date) + " " + date.toTimeString().slice(0, 8);
}

function slackMessageUser(message = {}) {
  return message.user || message.username || message.bot_id || "Unknown_User";
}

function slackMessageText(message = {}) {
  return String(message.text || message.blocks?.map(block => block.text?.text).filter(Boolean).join(" ") || "(내용 없음)").replace(/\r?\n/g, "\\n");
}

async function readOnlineManagementSlackMessages(days = 2) {
  const safeDays = Math.min(30, Math.max(1, Number.parseInt(days, 10) || 2));
  const channel = await findSlackChannelByName(ONLINE_MANAGEMENT_SLACK_CHANNEL);
  if (!channel) throw new Error(`Slack channel not found: #${ONLINE_MANAGEMENT_SLACK_CHANNEL}`);
  if (!channel.is_member && !channel.is_archived) {
    try {
      await slackApi("conversations.join", { channel: channel.id });
    } catch {
      // Private channels cannot be joined through this API. If the token is not
      // already a member, conversations.history will return the Slack error.
    }
  }

  const oldestDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const oldest = String(Math.floor(oldestDate.getTime() / 1000));
  const messages = await readSlackChannelMessages(channel.id, { oldest, inclusive: true });
  const rows = [...messages].reverse().map(message => ({
    ts: message.ts || "",
    time: formatSlackTimestamp(message.ts),
    user: slackMessageUser(message),
    text: slackMessageText(message)
  }));
  return {
    ok: true,
    channel: channel.name || ONLINE_MANAGEMENT_SLACK_CHANNEL,
    channelId: channel.id,
    days: safeDays,
    since: oldestDate.toISOString(),
    messages: rows
  };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function readGoogleServiceAccount() {
  if (!fs.existsSync(GOOGLE_SERVICE_ACCOUNT_FILE)) {
    throw new Error(`Google service account file not found: ${GOOGLE_SERVICE_ACCOUNT_FILE}`);
  }
  return JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8"));
}

let googleTokenCache = null;

async function googleAccessToken(scopes) {
  const now = Math.floor(Date.now() / 1000);
  if (googleTokenCache?.accessToken && googleTokenCache.expiresAt > now + 60) {
    return googleTokenCache.accessToken;
  }

  const account = readGoogleServiceAccount();
  if (!account.client_email || !account.private_key) {
    throw new Error("service_account.json is missing client_email or private_key");
  }

  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: account.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(account.private_key.replace(/\\n/g, "\n"))
    .toString("base64url");

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${signingInput}.${signature}`
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token request failed (${res.status})`);
  googleTokenCache = {
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600)
  };
  return googleTokenCache.accessToken;
}

async function googleApi(url, options = {}) {
  const token = await googleAccessToken([
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
  ]);
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error?.message || data?.error_description || data?.error || `Google API failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function quoteSheetName(title) {
  return `'${String(title || "").replace(/'/g, "''")}'`;
}

function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellA1(rowIndex, colIndex) {
  return `${columnName(colIndex)}${rowIndex + 2}`;
}

function parseThirdVisitSheetDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatThirdVisitSheetDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${Number(match[1])}. ${Number(match[2])}. ${Number(match[3])}`;
}

function compareIsoDate(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function ensureSheetRow(values, rowIndex, columnCount) {
  while (values.length <= rowIndex) values.push(Array(columnCount).fill(""));
  while (values[rowIndex].length < columnCount) values[rowIndex].push("");
}

function thirdVisitInsuranceType(visitType) {
  return String(visitType || "").includes("자보") ? "자보" : "건보";
}

function isThirdVisitPrescription(value) {
  return String(value || "").trim().replace(/\s+/g, "") === "-처방-";
}

function buildThirdVisitUpdates(sheetValues, visits) {
  if (!sheetValues.length) throw new Error("선택한 워크시트가 비어 있습니다.");
  const headers = sheetValues[0] || [];
  if (headers.length <= 20) throw new Error("시트의 컬럼 수가 부족합니다. 최소 21개 컬럼이 필요합니다.");

  const rows = sheetValues.slice(1).map(row => {
    const next = [...row];
    while (next.length < headers.length) next.push("");
    return next;
  });
  const existingFirstDates = rows.map(row => String(row[18] || "").trim()).filter(Boolean);
  if (!existingFirstDates.length) throw new Error("기존 시트의 19번째 컬럼에서 마지막 진료일을 찾지 못했습니다.");
  const lastDate = parseThirdVisitSheetDate(existingFirstDates[existingFirstDates.length - 1]);
  if (!lastDate) throw new Error(`기존 시트의 마지막 진료일 형식을 읽지 못했습니다: ${existingFirstDates[existingFirstDates.length - 1]}`);

  const periodRows = visits
    .filter(row => row.name && compareIsoDate(row.visitDate, lastDate) > 0)
    .map(row => ({
      name: String(row.name || "").trim(),
      doctorName: String(row.doctorName || "").trim(),
      visitType: String(row.visitType || "").trim(),
      chiefComplaint: String(row.chiefComplaint || "").trim(),
      visitDate: row.visitDate,
      sheetDate: formatThirdVisitSheetDate(row.visitDate)
    }))
    .filter(row => row.name && row.sheetDate);

  const newRows = periodRows
    .filter(row => normalizeVisitType(row.visitType) === "초진" && !isThirdVisitPrescription(row.chiefComplaint))
    .sort((a, b) => compareIsoDate(a.visitDate, b.visitDate));

  let lastFirstDateIndex = -1;
  rows.forEach((row, index) => {
    if (String(row[18] || "").trim()) lastFirstDateIndex = index;
  });

  const changedRows = new Set();
  newRows.forEach((row, index) => {
    const rowIndex = lastFirstDateIndex + 1 + index;
    ensureSheetRow(rows, rowIndex, headers.length);
    const values = [
      "",
      row.name,
      row.doctorName,
      thirdVisitInsuranceType(row.visitType),
      ...Array(14).fill(""),
      row.sheetDate
    ];
    for (let col = 0; col < values.length; col += 1) rows[rowIndex][col] = values[col];
    changedRows.add(rowIndex);
  });

  rows.forEach(row => { row[1] = String(row[1] || "").trim(); });

  const revisitRows = periodRows
    .filter(row => normalizeVisitType(row.visitType) === "재진")
    .sort((a, b) => compareIsoDate(a.visitDate, b.visitDate));
  const existingRevisitNames = new Set(rows.filter(row => revisitRows.some(visit => visit.name === row[1])).map(row => row[1]));
  const missingRevisitNames = [...new Set(revisitRows.map(row => row.name).filter(name => !existingRevisitNames.has(name)))].sort();

  for (const row of revisitRows) {
    const rowIndex = rows.map((sheetRow, index) => sheetRow[1] === row.name ? index : -1).filter(index => index >= 0).pop();
    if (rowIndex === undefined) continue;

    const firstDate = parseThirdVisitSheetDate(rows[rowIndex][18]);
    if (!firstDate) continue;
    if (compareIsoDate(row.visitDate, firstDate) <= 0) continue;
    if (compareIsoDate(row.visitDate, addDays(firstDate, 21)) > 0) continue;

    if (!String(rows[rowIndex][19] || "").trim()) {
      rows[rowIndex][19] = row.sheetDate;
      changedRows.add(rowIndex);
      continue;
    }
    if (rows[rowIndex][19] === row.sheetDate) continue;

    const secondDate = parseThirdVisitSheetDate(rows[rowIndex][19]);
    if (!String(rows[rowIndex][20] || "").trim() && secondDate && compareIsoDate(secondDate, row.visitDate) < 0) {
      rows[rowIndex][20] = row.sheetDate;
      changedRows.add(rowIndex);
    }
  }

  const updateCols = [1, 2, 3, 18, 19, 20];
  const updates = [];
  for (const rowIndex of [...changedRows].sort((a, b) => a - b)) {
    for (const colIndex of updateCols) {
      updates.push({
        rowIndex,
        colIndex,
        range: cellA1(rowIndex, colIndex),
        values: [[rows[rowIndex][colIndex] || ""]]
      });
    }
  }

  return {
    lastDate: formatThirdVisitSheetDate(lastDate),
    totalVisits: periodRows.length,
    newPatients: newRows.length,
    revisitPatients: revisitRows.length,
    missingRevisitNames,
    changedRows: [...changedRows].sort((a, b) => a - b),
    updates
  };
}

async function copyThirdVisitSpreadsheet(shareEmail = "") {
  const name = `3차 내원 체크 테스트 ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`;
  const file = await googleApi(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(THIRD_VISIT_SPREADSHEET_ID)}/copy?supportsAllDrives=true`, {
    method: "POST",
    body: JSON.stringify({ name })
  });
  const email = normalizeSearchText(shareEmail);
  if (email) {
    await googleApi(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
      method: "POST",
      body: JSON.stringify({ type: "user", role: "writer", emailAddress: email })
    });
  }
  return file;
}

async function runThirdVisitGoogleSheetTest(shareEmail = "") {
  const copied = await copyThirdVisitSpreadsheet(shareEmail);
  const spreadsheet = await googleApi(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(copied.id)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`);
  const sheet = spreadsheet.sheets?.[THIRD_VISIT_WORKSHEET_INDEX]?.properties;
  if (!sheet?.title) throw new Error(`구글 시트에 ${THIRD_VISIT_WORKSHEET_INDEX + 1}번째 워크시트가 없습니다.`);

  const range = `${quoteSheetName(sheet.title)}!A:ZZ`;
  const valueData = await googleApi(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(copied.id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
  const lastCol19Values = (valueData.values || []).slice(1).map(row => row?.[18]).filter(Boolean);
  const lastDate = parseThirdVisitSheetDate(lastCol19Values[lastCol19Values.length - 1]);
  if (!lastDate) throw new Error("기존 시트의 마지막 진료일을 읽지 못했습니다.");

  const visits = statements.listVisitsAfterDate.all(lastDate).map(row => ({
    name: row.name || "",
    doctorName: row.doctor_name || "",
    visitType: row.visit_type || "",
    chiefComplaint: row.chief_complaint || "",
    visitDate: row.visit_date || ""
  }));
  const result = buildThirdVisitUpdates(valueData.values || [], visits);
  if (result.updates.length) {
    await googleApi(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(copied.id)}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: result.updates.map(update => ({
          range: `${quoteSheetName(sheet.title)}!${update.range}`,
          values: update.values
        }))
      })
    });
  }

  return {
    ok: true,
    sourceSpreadsheetId: THIRD_VISIT_SPREADSHEET_ID,
    testSpreadsheetId: copied.id,
    testSpreadsheetUrl: spreadsheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
    worksheetTitle: sheet.title,
    worksheetIndex: THIRD_VISIT_WORKSHEET_INDEX,
    savedToSource: false,
    updatedCells: result.updates.length,
    ...result
  };
}

async function backupSlackText() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(SLACK_BACKUP_DIR, `slack-text-backup-${stamp}.txt`);
  const lines = [
    "=== Slack Text Backup ===",
    `Backup time: ${new Date().toLocaleString("ko-KR")}`,
    ""
  ];
  const errors = [];
  let messageCount = 0;
  const channels = await listSlackChannels();

  for (const channel of channels) {
    const channelName = channel.name || channel.id;
    try {
      if (!channel.is_member && !channel.is_archived) {
        try {
          await slackApi("conversations.join", { channel: channel.id });
        } catch (error) {
          errors.push(`#${channelName} join 실패: ${error.message}`);
        }
      }
      const messages = await readSlackChannelMessages(channel.id);
      messageCount += messages.length;
      lines.push("==========================================");
      lines.push(`채널: #${channelName} (${messages.length}개 메시지)`);
      lines.push("==========================================");
      if (!messages.length) {
        lines.push("(대화 내용이 없습니다.)", "");
        continue;
      }
      for (const message of [...messages].reverse()) {
        lines.push(`[${formatSlackTimestamp(message.ts)}] ${slackMessageUser(message)}: ${slackMessageText(message)}`);
      }
      lines.push("");
    } catch (error) {
      errors.push(`#${channelName} 백업 실패: ${error.message}`);
      lines.push("==========================================");
      lines.push(`채널: #${channelName}`);
      lines.push(`백업 실패: ${error.message}`);
      lines.push("");
    }
  }

  if (errors.length) {
    lines.push("=== Errors ===");
    errors.forEach(error => lines.push(error));
    lines.push("");
  }
  fs.writeFileSync(file, lines.join("\r\n"), "utf8");
  const retention = pruneSlackTextBackups(1095);
  return {
    ok: true,
    file,
    filename: path.basename(file),
    channels: channels.length,
    messages: messageCount,
    errors,
    retention
  };
}

function parsePatientImportPayload(payload) {
  const records = Array.isArray(payload) ? payload : payload?.patients;
  const mode = Array.isArray(payload) ? "merge" : (payload?.mode || "merge");
  const shouldBackup = Array.isArray(payload) ? true : payload?.backup !== false;
  if (!Array.isArray(records)) throw new Error("JSON array or { patients: [] } is required");
  return { records, mode, shouldBackup };
}

function importPatients(records, mode = "merge", shouldBackup = true) {
  if (shouldBackup) {
    const before = mode === "replace"
      ? listPatients()
      : getPatients([...new Set(records.map(record => normalizeChartNo(record?.chartNo)).filter(Boolean))]);
    if (before.length) backupPatients(before, mode === "replace" ? "before-replace-import" : "before-import");
  }
  if (mode === "replace") {
    statements.deleteAllPatients.run();
    statements.deleteAllPatientVisits.run();
    clearPatientCache();
  }
  let saved = 0;
  db.exec("BEGIN");
  try {
    for (const record of records) {
      if (!normalizeChartNo(record?.chartNo)) continue;
      savePatient(record);
      saved += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    invalidatePatientCache();
    throw error;
  }
  return { ok: true, mode, saved, skipped: records.length - saved };
}

function normalizeStateKey(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function getStateValue(key) {
  const stateKey = normalizeStateKey(key);
  if (stateValueCache.has(stateKey)) return stateValueCache.get(stateKey);
  const row = statements.getState.get(stateKey);
  const value = row ? JSON.parse(decrypt(row.data_json)) : null;
  stateValueCache.set(stateKey, value);
  return value;
}

function setStateValue(key, value) {
  const stateKey = normalizeStateKey(key);
  if (!stateKey) throw new Error("state key is required");
  const saved = value ?? null;
  statements.upsertState.run(stateKey, encrypt(JSON.stringify(saved)), new Date().toISOString());
  stateValueCache.set(stateKey, saved);
  return saved;
}

function patchObject(base, patch) {
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  return { ...base, ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) };
}

// --- Authentication (shared password + HttpOnly session cookie) ---------------

// Constant-time string compare to avoid leaking the password via timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Sessions live in memory for fast per-request checks and are persisted to the
// (encrypted) app_state table so devices stay logged in across server restarts.
const sessions = new Map(); // sid -> expiry epoch ms
const SESSION_STATE_KEY = "__sessions";

(function hydrateSessions() {
  const stored = getStateValue(SESSION_STATE_KEY);
  if (stored && typeof stored === "object") {
    const now = Date.now();
    for (const [sid, expiry] of Object.entries(stored)) {
      if (typeof expiry === "number" && expiry > now) sessions.set(sid, expiry);
    }
  }
})();

function persistSessions() {
  const obj = {};
  for (const [sid, expiry] of sessions) obj[sid] = expiry;
  setStateValue(SESSION_STATE_KEY, obj);
}

function createSession() {
  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  persistSessions();
  return sid;
}

function destroySession(sid) {
  if (sid && sessions.delete(sid)) persistSessions();
}

function isValidSession(sid) {
  if (!sid) return false;
  const expiry = sessions.get(sid);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(sid);
    persistSessions();
    return false;
  }
  return true;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSid(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

function loginPageHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>로그인</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f4f5f7; }
  form { background: #fff; padding: 32px 28px; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.08); width: 280px; }
  h1 { font-size: 18px; margin: 0 0 18px; text-align: center; }
  input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px; border: 1px solid #ccc; border-radius: 8px; }
  button { width: 100%; margin-top: 14px; padding: 12px; font-size: 16px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
  .err { color: #dc2626; font-size: 14px; margin-top: 10px; min-height: 18px; text-align: center; }
</style>
</head>
<body>
<form id="f">
  <h1>비밀번호 입력</h1>
  <input id="pw" type="password" autocomplete="current-password" autofocus />
  <button type="submit">로그인</button>
  <div class="err" id="err"></div>
</form>
<script>
  const f = document.getElementById('f'), pw = document.getElementById('pw'), err = document.getElementById('err');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
    if (res.ok) { location.href = '/'; }
    else { err.textContent = '비밀번호가 올바르지 않습니다.'; pw.value = ''; pw.focus(); }
  });
</script>
</body>
</html>`;
}

// --- Realtime bed state (SSE push + atomic updates + CAS transactions) -------
// `beds` lives in app_state (encrypted). Node runs one request handler at a
// time, so each read-merge-write below is atomic without locking. Cross-device
// updates are pushed live over Server-Sent Events. Transactions use an optimistic
// version check (compare-and-set) so conflicting writes can be retried.

const sseClients = new Set();

function sseSend(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseSendFrame(res, frame) {
  res.write(frame);
}

// Push a generic app_state key change to all connected clients (staff, settings,
// etc.). This is the local server equivalent of realtime state subscriptions.
function sseBroadcastState(key, value) {
  const frame = sseFrame("state", { key, value });
  for (const client of sseClients) {
    try { sseSendFrame(client, frame); } catch { sseClients.delete(client); }
  }
}

function sseBroadcastStateChild(key, op, childKey, value) {
  const frame = sseFrame("state-child", { key, op, childKey, value });
  for (const client of sseClients) {
    try { sseSendFrame(client, frame); } catch { sseClients.delete(client); }
  }
}

function getBedsState() {
  return getStateValue("beds") || {};
}

function getBedsVersion() {
  const v = getStateValue("__bedsVersion");
  return typeof v === "number" ? v : 0;
}

function commitBeds(beds) {
  const next = beds || {};
  setStateValue("beds", next);
  const version = getBedsVersion() + 1;
  setStateValue("__bedsVersion", version);
  const frame = sseFrame("beds", { version, beds: next });
  for (const client of sseClients) {
    try { sseSendFrame(client, frame); } catch { sseClients.delete(client); }
  }
  return version;
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    sseSend(res, "beds", { version: getBedsVersion(), beds: getBedsState() });
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* closed */ }
    }, 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return true;
  }

  if (pathname === "/api/beds" && req.method === "GET") {
    jsonResponse(res, 200, { version: getBedsVersion(), beds: getBedsState() });
    return true;
  }

  if (pathname === "/api/beds/update" && req.method === "POST") {
    const { bedNo, patch } = (await readJson(req)) || {};
    const beds = getBedsState();
    const key = String(bedNo);
    beds[key] = { ...(beds[key] || {}), ...(patch || {}) };
    jsonResponse(res, 200, { ok: true, version: commitBeds(beds) });
    return true;
  }

  if (pathname === "/api/beds/update-child" && req.method === "POST") {
    const { bedNo, childKey, patch } = (await readJson(req)) || {};
    const beds = getBedsState();
    const key = String(bedNo);
    if (!beds[key]) { jsonResponse(res, 200, { ok: false, reason: "no-bed" }); return true; }
    beds[key][childKey] = { ...(beds[key][childKey] || {}), ...(patch || {}) };
    jsonResponse(res, 200, { ok: true, version: commitBeds(beds) });
    return true;
  }

  if (pathname === "/api/beds/remove" && req.method === "POST") {
    const { bedNo } = (await readJson(req)) || {};
    const beds = getBedsState();
    delete beds[String(bedNo)];
    jsonResponse(res, 200, { ok: true, version: commitBeds(beds) });
    return true;
  }

  // Compare-and-set: client sends the whole next beds tree + the version it read.
  // Rejected (409) with the current state if another device wrote first, so the
  // client can re-run its mutator and retry (= runTransaction).
  if (pathname === "/api/beds/cas" && req.method === "POST") {
    const { expectedVersion, beds } = (await readJson(req)) || {};
    const current = getBedsVersion();
    if (typeof expectedVersion === "number" && expectedVersion !== current) {
      jsonResponse(res, 409, { ok: false, conflict: true, version: current, beds: getBedsState() });
      return true;
    }
    jsonResponse(res, 200, { ok: true, version: commitBeds(beds || {}) });
    return true;
  }

  // Atomic child operations on a collection-style app_state key (staff, settings,
  // alerts, patients). Node runs one handler at a time, so read-merge-write here
  // is atomic — multiple devices editing different children won't lose updates,
  // unlike a client-side whole-map read-modify-write. Broadcasts the new map.
  const childMatch = pathname.match(/^\/api\/state-child\/(merge|push|delete)$/);
  if (childMatch && req.method === "POST") {
    const op = childMatch[1];
    const body = (await readJson(req)) || {};
    const key = normalizeStateKey(body.key);
    if (!key || key.startsWith("__")) { jsonResponse(res, 400, { error: "bad key" }); return true; }
    const map = getStateValue(key) || {};
    let childKey = body.childKey;
    if (op === "merge") {
      map[childKey] = { ...(map[childKey] || {}), ...(body.patch || {}) };
    } else if (op === "push") {
      childKey = `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      map[childKey] = body.value ?? null;
    } else if (op === "delete") {
      delete map[childKey];
    }
    setStateValue(key, map);
    sseBroadcastStateChild(key, op, childKey, op === "delete" ? null : map[childKey]);
    jsonResponse(res, 200, { ok: true, key, childKey });
    return true;
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const payload = await readJson(req);
    if (!safeEqual(payload?.password || "", LOGIN_PASSWORD)) {
      jsonResponse(res, 401, { error: "Invalid password" });
      return true;
    }
    const sid = createSession();
    res.writeHead(200, {
      "Set-Cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    destroySession(getSid(req));
    res.writeHead(200, {
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    jsonResponse(res, 200, { ok: true, dbPath: DB_PATH, count: countPatients() });
    return true;
  }

  if (pathname === "/api/patients/count" && req.method === "GET") {
    jsonResponse(res, 200, { count: countPatients() });
    return true;
  }

  if (pathname === "/api/stats/doctors" && req.method === "GET") {
    jsonResponse(res, 200, collectStatsDoctors());
    return true;
  }

  if (pathname === "/api/stats" && req.method === "GET") {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const start = requestUrl.searchParams.get("start") || "";
    const end = requestUrl.searchParams.get("end") || "";
    const docFilter = requestUrl.searchParams.get("doctor") || "";
    const chartUnit = requestUrl.searchParams.get("unit") || "week";
    jsonResponse(res, 200, computeClinicStats({ start, end, docFilter, chartUnit }));
    return true;
  }

  if (pathname === "/api/patients/search" && req.method === "GET") {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    jsonResponse(res, 200, searchPatients(requestUrl.searchParams.get("q") || "", requestUrl.searchParams.get("limit") || 50));
    return true;
  }

  if (pathname === "/api/patients/batch" && req.method === "POST") {
    const payload = await readJson(req);
    const chartNos = Array.isArray(payload) ? payload : payload?.chartNos;
    if (!Array.isArray(chartNos)) throw new Error("JSON array or { chartNos: [] } is required");
    jsonResponse(res, 200, getPatients([...new Set(chartNos.map(normalizeChartNo).filter(Boolean))]));
    return true;
  }

  if (pathname === "/api/patients/visits/month" && req.method === "GET") {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    jsonResponse(res, 200, patientsByVisitMonth(requestUrl.searchParams.get("month") || ""));
    return true;
  }

  if (pathname === "/api/patients" && req.method === "GET") {
    jsonResponse(res, 200, listPatients());
    return true;
  }

  if (pathname === "/api/patients" && req.method === "POST") {
    const record = await readJson(req);
    jsonResponse(res, 200, savePatient(record));
    return true;
  }

  if (pathname === "/api/patients" && req.method === "DELETE") {
    const payload = await readJson(req);
    if (!safeEqual(payload?.password || "", DELETE_PASSWORD)) {
      jsonResponse(res, 403, { error: "Invalid password" });
      return true;
    }
    const before = listPatients();
    if (before.length) backupPatients(before, "delete-all");
    statements.deleteAllPatients.run();
    statements.deleteAllPatientVisits.run();
    clearPatientCache();
    jsonResponse(res, 200, { ok: true, deleted: before.length });
    return true;
  }

  const patientIdMatch = pathname.match(/^\/api\/patients\/id\/([^/]+)$/);
  if (patientIdMatch) {
    const patientId = normalizeSearchText(decodeURIComponent(patientIdMatch[1]));
    if (req.method === "GET") {
      const patient = getPatientById(patientId);
      if (!patient) jsonResponse(res, 404, { error: "Patient not found" });
      else jsonResponse(res, 200, patient);
      return true;
    }
    if (req.method === "PUT") {
      const record = await readJson(req);
      jsonResponse(res, 200, savePatient({ ...record, patientId }));
      return true;
    }
    if (req.method === "DELETE") {
      const before = getPatientById(patientId);
      if (before) backupPatients([before], `delete-${before.chartNo || patientId}`);
      statements.deletePatient.run(patientId);
      statements.deletePatientVisits.run(patientId);
      removeCachedPatient(patientId);
      jsonResponse(res, 200, { ok: true, deleted: Boolean(before), patientId });
      return true;
    }
  }

  const patientMatch = pathname.match(/^\/api\/patients\/([^/]+)$/);
  if (patientMatch) {
    const chartNo = normalizeChartNo(decodeURIComponent(patientMatch[1]));
    if (req.method === "GET") {
      const patient = getPatient(chartNo);
      if (!patient) jsonResponse(res, 404, { error: "Patient not found" });
      else jsonResponse(res, 200, patient);
      return true;
    }
    if (req.method === "PUT") {
      const record = await readJson(req);
      jsonResponse(res, 200, savePatient({ ...record, chartNo: normalizeChartNo(record?.chartNo || chartNo) }));
      return true;
    }
    if (req.method === "DELETE") {
      const matches = getPatientsByChartNo(chartNo);
      if (matches.length > 1) {
        jsonResponse(res, 409, { error: "Multiple patients share this chartNo. Delete by patientId.", chartNo, count: matches.length });
        return true;
      }
      const before = matches[0] || null;
      if (before) backupPatients([before], `delete-${chartNo}`);
      if (before?.patientId) {
        statements.deletePatient.run(before.patientId);
        statements.deletePatientVisits.run(before.patientId);
        removeCachedPatient(before.patientId);
      }
      jsonResponse(res, 200, { ok: true, deleted: Boolean(before), chartNo });
      return true;
    }
  }

  if (pathname === "/api/import/patients" && req.method === "POST") {
    const payload = await readJson(req);
    const { records, mode, shouldBackup } = parsePatientImportPayload(payload);
    jsonResponse(res, 200, importPatients(records, mode, shouldBackup));
    return true;
  }

  if (pathname === "/api/import/patients-encrypted" && req.method === "POST") {
    const raw = await readBody(req, LARGE_BODY_LIMIT_BYTES);
    const payload = JSON.parse(decrypt(raw));
    const { records, mode, shouldBackup } = parsePatientImportPayload(payload);
    jsonResponse(res, 200, importPatients(records, mode, shouldBackup));
    return true;
  }

  if (pathname === "/api/export/patients" && req.method === "GET") {
    const records = listPatients();
    const { file, body } = encryptedPatientBackup(records, "manual-export");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="patientChartDB-patients-${new Date().toISOString().slice(0, 10)}.json.enc"`,
      "X-Backup-File": path.basename(file)
    });
    res.end(body);
    return true;
  }

  if (pathname === "/api/backup/slack-text" && req.method === "POST") {
    jsonResponse(res, 200, await backupSlackText());
    return true;
  }

  if (pathname === "/api/slack/online-management" && req.method === "GET") {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    jsonResponse(res, 200, await readOnlineManagementSlackMessages(requestUrl.searchParams.get("days")));
    return true;
  }

  if (pathname === "/api/google/third-visit-test-sync" && req.method === "POST") {
    const payload = await readJson(req);
    jsonResponse(res, 200, await runThirdVisitGoogleSheetTest(payload?.shareEmail || ""));
    return true;
  }

  const stateMatch = pathname.match(/^\/api\/state\/(.+)$/);
  if (stateMatch) {
    const key = decodeURIComponent(stateMatch[1]);
    // Keys starting with "__" are reserved for internal use (e.g. sessions) and
    // must never be reachable through the public state API.
    if (normalizeStateKey(key).startsWith("__")) {
      jsonResponse(res, 403, { error: "Reserved key" });
      return true;
    }
    if (req.method === "GET") {
      jsonResponse(res, 200, { key: normalizeStateKey(key), value: getStateValue(key) });
      return true;
    }
    if (req.method === "PUT") {
      const payload = await readJson(req);
      const value = Object.prototype.hasOwnProperty.call(payload || {}, "value") ? payload.value : payload;
      const saved = setStateValue(key, value);
      sseBroadcastState(normalizeStateKey(key), saved);
      jsonResponse(res, 200, { key: normalizeStateKey(key), value: saved });
      return true;
    }
    if (req.method === "PATCH") {
      const payload = await readJson(req);
      const patch = Object.prototype.hasOwnProperty.call(payload || {}, "value") ? payload.value : payload;
      const value = patchObject(getStateValue(key), patch);
      const saved = setStateValue(key, value);
      sseBroadcastState(normalizeStateKey(key), saved);
      jsonResponse(res, 200, { key: normalizeStateKey(key), value: saved });
      return true;
    }
    if (req.method === "DELETE") {
      statements.deleteState.run(normalizeStateKey(key));
      stateValueCache.set(normalizeStateKey(key), null);
      sseBroadcastState(normalizeStateKey(key), null);
      jsonResponse(res, 200, { ok: true, key: normalizeStateKey(key) });
      return true;
    }
  }

  return false;
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.resolve(ROOT_DIR, "." + safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    textResponse(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    textResponse(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Login page is always reachable.
    if (pathname === "/login" && (req.method === "GET" || req.method === "HEAD")) {
      const body = loginPageHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    // Authentication gate. Login/logout endpoints stay open so a user can sign
    // in; everything else requires a valid session.
    const isAuthEndpoint = pathname === "/api/login" || pathname === "/api/logout";
    if (!isAuthEndpoint && !isValidSession(getSid(req))) {
      if (pathname.startsWith("/api/")) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }
      // Pages redirect to the login screen; static assets (js/css/img/manifest)
      // load freely so the login page and PWA shell work.
      const ext = path.extname(pathname).toLowerCase();
      if (pathname === "/" || ext === ".html") {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
    }

    if (pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, pathname);
      if (!handled) jsonResponse(res, 404, { error: "API not found" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      textResponse(res, 405, "Method not allowed");
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    jsonResponse(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Inhouse local server running`);
  console.log(`Local:   http://127.0.0.1:${PORT}/`);
  console.log(`Network: http://<this-pc-ip>:${PORT}/`);
  console.log(`DB:      ${DB_PATH}`);
  console.log(`Key:     ${KEY_PATH} (encryption at rest enabled)`);
  console.log(`Auth:    login required (set CLINIC_PASSWORD env to change)`);
  if (!process.env.CLINIC_PASSWORD || !process.env.CLINIC_DELETE_PASSWORD) {
    console.warn("[auth] WARNING: using default password(s). Set CLINIC_PASSWORD and CLINIC_DELETE_PASSWORD env vars for production.");
  }
});
