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
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "clinic.db");

// Login password (gates every page and API) and the delete-all confirmation
// password. Both are read from env so they are not hardcoded; defaults keep the
// app working on first run but should be overridden in production.
const LOGIN_PASSWORD = process.env.CLINIC_PASSWORD || "7677";
const DELETE_PASSWORD = process.env.CLINIC_DELETE_PASSWORD || "337758";
const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365; // 1 year — enter once per device

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS patients (
    chart_no TEXT PRIMARY KEY,
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
    chart_no TEXT NOT NULL,
    visit_date TEXT NOT NULL,
    doctor_name TEXT,
    visit_type TEXT,
    chief_complaint TEXT,
    PRIMARY KEY (chart_no, visit_date)
  );
  CREATE INDEX IF NOT EXISTS idx_patient_visits_date ON patient_visits (visit_date);
`);

function ensurePatientSearchColumns() {
  const columns = new Set(db.prepare("PRAGMA table_info(patients)").all().map(column => column.name));
  if (!columns.has("name")) db.exec("ALTER TABLE patients ADD COLUMN name TEXT");
  if (!columns.has("phone")) db.exec("ALTER TABLE patients ADD COLUMN phone TEXT");
}

ensurePatientSearchColumns();

const statements = {
  listPatients: db.prepare("SELECT data_json FROM patients ORDER BY chart_no COLLATE NOCASE"),
  countPatients: db.prepare("SELECT COUNT(*) AS count FROM patients"),
  searchPatients: db.prepare(`
    SELECT data_json FROM patients
    WHERE chart_no LIKE ? ESCAPE '\\'
       OR name LIKE ? ESCAPE '\\'
       OR phone LIKE ? ESCAPE '\\'
    ORDER BY chart_no COLLATE NOCASE
    LIMIT ?
  `),
  getPatient: db.prepare("SELECT data_json FROM patients WHERE chart_no = ?"),
  upsertPatient: db.prepare(`
    INSERT INTO patients (chart_no, name, phone, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chart_no) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `),
  deletePatient: db.prepare("DELETE FROM patients WHERE chart_no = ?"),
  deleteAllPatients: db.prepare("DELETE FROM patients"),
  deletePatientVisits: db.prepare("DELETE FROM patient_visits WHERE chart_no = ?"),
  deleteAllPatientVisits: db.prepare("DELETE FROM patient_visits"),
  upsertPatientVisit: db.prepare(`
    INSERT INTO patient_visits (chart_no, visit_date, doctor_name, visit_type, chief_complaint)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chart_no, visit_date) DO UPDATE SET
      doctor_name = excluded.doctor_name,
      visit_type = excluded.visit_type,
      chief_complaint = excluded.chief_complaint
  `),
  listVisitChartNosByMonth: db.prepare(`
    SELECT
      pv.chart_no,
      pv.visit_date,
      pv.doctor_name,
      pv.visit_type,
      pv.chief_complaint,
      p.name,
      p.phone
    FROM patient_visits pv
    LEFT JOIN patients p ON p.chart_no = pv.chart_no
    WHERE pv.visit_date >= ? AND pv.visit_date <= ?
    ORDER BY pv.visit_date, pv.chart_no COLLATE NOCASE
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
  const patientRows = db.prepare("SELECT chart_no, data_json FROM patients").all();
  const stateRows = db.prepare("SELECT state_key, data_json FROM app_state").all();
  const updatePatient = db.prepare("UPDATE patients SET data_json = ? WHERE chart_no = ?");
  const updateState = db.prepare("UPDATE app_state SET data_json = ? WHERE state_key = ?");
  let migrated = 0;
  db.exec("BEGIN");
  try {
    for (const row of patientRows) {
      if (!isEncrypted(row.data_json)) {
        updatePatient.run(encrypt(row.data_json), row.chart_no);
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
  const rows = db.prepare("SELECT chart_no, name, phone, data_json FROM patients WHERE name IS NULL OR phone IS NULL").all();
  if (!rows.length) return;
  const update = db.prepare("UPDATE patients SET name = ?, phone = ? WHERE chart_no = ?");
  let updated = 0;
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const record = JSON.parse(decrypt(row.data_json));
      update.run(normalizeSearchText(record.name), getPatientPhone(record), row.chart_no);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > 50 * 1024 * 1024) {
        reject(new Error("Request body too large"));
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
  return JSON.parse(decrypt(row.data_json));
}

function listPatients() {
  return statements.listPatients.all().map(parsePatientRow);
}

function countPatients() {
  return Number(statements.countPatients.get()?.count || 0);
}

function searchPatients(query, limit = 50) {
  const q = normalizeSearchText(query);
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)));
  const pattern = `%${escapeLike(q)}%`;
  return statements.searchPatients.all(pattern, pattern, pattern, safeLimit).map(parsePatientRow);
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
  if (!chartNo) return;
  statements.deletePatientVisits.run(chartNo);
  for (const entry of visitEntriesFromRecord(record)) {
    statements.upsertPatientVisit.run(chartNo, entry.date, entry.doctorName, entry.visitType, entry.chiefComplaint);
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
  const patientsByChart = new Map();
  for (const row of statements.listVisitChartNosByMonth.all(start, end)) {
    counts[row.visit_date] = (counts[row.visit_date] || 0) + 1;
    const chartNo = normalizeChartNo(row.chart_no);
    if (!chartNo) continue;
    const patient = patientsByChart.get(chartNo) || {
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
    patientsByChart.set(chartNo, patient);
  }
  const records = [...patientsByChart.values()];
  records.sort((a, b) => normalizeChartNo(a.chartNo).localeCompare(normalizeChartNo(b.chartNo), "ko", { numeric: true }));
  return { month: normalizedMonth, counts, patients: records };
}

function getPatient(chartNo) {
  const row = statements.getPatient.get(chartNo);
  return row ? parsePatientRow(row) : null;
}

function getPatients(chartNos) {
  const records = [];
  for (const chartNo of chartNos) {
    const normalized = normalizeChartNo(chartNo);
    if (!normalized) continue;
    const record = getPatient(normalized);
    if (record) records.push(record);
  }
  return records;
}

function savePatient(record) {
  const chartNo = normalizeChartNo(record?.chartNo);
  if (!chartNo) throw new Error("chartNo is required");
  const now = new Date().toISOString();
  const normalized = { ...record, chartNo };
  statements.upsertPatient.run(
    chartNo,
    normalizeSearchText(normalized.name),
    getPatientPhone(normalized),
    encrypt(JSON.stringify(normalized)),
    now
  );
  syncPatientVisitIndex(normalized);
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
    throw error;
  }
  return { ok: true, mode, saved, skipped: records.length - saved };
}

function normalizeStateKey(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function getStateValue(key) {
  const row = statements.getState.get(normalizeStateKey(key));
  return row ? JSON.parse(decrypt(row.data_json)) : null;
}

function setStateValue(key, value) {
  const stateKey = normalizeStateKey(key);
  if (!stateKey) throw new Error("state key is required");
  statements.upsertState.run(stateKey, encrypt(JSON.stringify(value ?? null)), new Date().toISOString());
  return value ?? null;
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

// Push a generic app_state key change to all connected clients (staff, settings,
// etc.). This is the local server equivalent of realtime state subscriptions.
function sseBroadcastState(key, value) {
  const frame = { key, value };
  for (const client of sseClients) {
    try { sseSend(client, "state", frame); } catch { sseClients.delete(client); }
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
  const frame = { version, beds: next };
  for (const client of sseClients) {
    try { sseSend(client, "beds", frame); } catch { sseClients.delete(client); }
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
    sseBroadcastState(key, map);
    jsonResponse(res, 200, { ok: true, key, childKey, value: map });
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
    jsonResponse(res, 200, { ok: true, deleted: before.length });
    return true;
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
      const before = getPatient(chartNo);
      if (before) backupPatients([before], `delete-${chartNo}`);
      statements.deletePatient.run(chartNo);
      statements.deletePatientVisits.run(chartNo);
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
    const raw = await readBody(req);
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
