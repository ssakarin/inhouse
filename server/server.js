const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const BACKUP_DIR = path.join(__dirname, "backups");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "clinic.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS patients (
    chart_no TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_state (
    state_key TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const statements = {
  listPatients: db.prepare("SELECT data_json FROM patients ORDER BY chart_no COLLATE NOCASE"),
  getPatient: db.prepare("SELECT data_json FROM patients WHERE chart_no = ?"),
  upsertPatient: db.prepare(`
    INSERT INTO patients (chart_no, data_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chart_no) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `),
  deletePatient: db.prepare("DELETE FROM patients WHERE chart_no = ?"),
  deleteAllPatients: db.prepare("DELETE FROM patients"),
  getState: db.prepare("SELECT data_json FROM app_state WHERE state_key = ?"),
  upsertState: db.prepare(`
    INSERT INTO app_state (state_key, data_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `),
  deleteState: db.prepare("DELETE FROM app_state WHERE state_key = ?")
};

function normalizeChartNo(value) {
  return String(value || "").trim().replace(/\.0$/, "");
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
  return JSON.parse(row.data_json);
}

function listPatients() {
  return statements.listPatients.all().map(parsePatientRow);
}

function getPatient(chartNo) {
  const row = statements.getPatient.get(chartNo);
  return row ? parsePatientRow(row) : null;
}

function savePatient(record) {
  const chartNo = normalizeChartNo(record?.chartNo);
  if (!chartNo) throw new Error("chartNo is required");
  const now = new Date().toISOString();
  const normalized = { ...record, chartNo };
  statements.upsertPatient.run(chartNo, JSON.stringify(normalized), now);
  return normalized;
}

function backupPatients(records, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `patients-${reason}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(records, null, 2), "utf8");
  return file;
}

function normalizeStateKey(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function getStateValue(key) {
  const row = statements.getState.get(normalizeStateKey(key));
  return row ? JSON.parse(row.data_json) : null;
}

function setStateValue(key, value) {
  const stateKey = normalizeStateKey(key);
  if (!stateKey) throw new Error("state key is required");
  statements.upsertState.run(stateKey, JSON.stringify(value ?? null), new Date().toISOString());
  return value ?? null;
}

function patchObject(base, patch) {
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  return { ...base, ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health" && req.method === "GET") {
    jsonResponse(res, 200, { ok: true, dbPath: DB_PATH, count: listPatients().length });
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
      jsonResponse(res, 200, { ok: true, deleted: Boolean(before), chartNo });
      return true;
    }
  }

  if (pathname === "/api/import/patients" && req.method === "POST") {
    const payload = await readJson(req);
    const records = Array.isArray(payload) ? payload : payload?.patients;
    const mode = Array.isArray(payload) ? "merge" : (payload?.mode || "merge");
    if (!Array.isArray(records)) throw new Error("JSON array or { patients: [] } is required");
    const before = listPatients();
    backupPatients(before, "before-import");
    if (mode === "replace") statements.deleteAllPatients.run();
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
    jsonResponse(res, 200, { ok: true, mode, saved, skipped: records.length - saved });
    return true;
  }

  if (pathname === "/api/export/patients" && req.method === "GET") {
    const records = listPatients();
    const body = JSON.stringify(records, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="patientChartDB-patients-${new Date().toISOString().slice(0, 10)}.json"`
    });
    res.end(body);
    return true;
  }

  const stateMatch = pathname.match(/^\/api\/state\/(.+)$/);
  if (stateMatch) {
    const key = decodeURIComponent(stateMatch[1]);
    if (req.method === "GET") {
      jsonResponse(res, 200, { key: normalizeStateKey(key), value: getStateValue(key) });
      return true;
    }
    if (req.method === "PUT") {
      const payload = await readJson(req);
      const value = Object.prototype.hasOwnProperty.call(payload || {}, "value") ? payload.value : payload;
      jsonResponse(res, 200, { key: normalizeStateKey(key), value: setStateValue(key, value) });
      return true;
    }
    if (req.method === "PATCH") {
      const payload = await readJson(req);
      const patch = Object.prototype.hasOwnProperty.call(payload || {}, "value") ? payload.value : payload;
      const value = patchObject(getStateValue(key), patch);
      jsonResponse(res, 200, { key: normalizeStateKey(key), value: setStateValue(key, value) });
      return true;
    }
    if (req.method === "DELETE") {
      statements.deleteState.run(normalizeStateKey(key));
      jsonResponse(res, 200, { ok: true, key: normalizeStateKey(key) });
      return true;
    }
  }

  return false;
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url.pathname);
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
});
