"use strict";

// Creates an encrypted full patient backup and applies a retention policy.
//
// Default policy:
// - keep all backups from the last 30 days
// - after 30 days, keep the newest backup per month
// - delete backups older than 365 days
//
// Usage:
//   node server/backup-patients.js
//   node server/backup-patients.js --backup-dir "G:\My Drive\clinic-backups"
//   node server/backup-patients.js --dry-run

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { encrypt, decrypt } = require("./crypto-util");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "clinic.db");
const DEFAULT_BACKUP_DIR = process.env.CLINIC_BACKUP_DIR || path.join(__dirname, "backups");

const args = process.argv.slice(2);

function readArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const BACKUP_DIR = path.resolve(ROOT_DIR, readArg("--backup-dir", DEFAULT_BACKUP_DIR));
const DRY_RUN = hasFlag("--dry-run");
const KEEP_ALL_DAYS = Number(readArg("--keep-all-days", "30"));
const KEEP_MONTHLY_DAYS = Number(readArg("--keep-monthly-days", "365"));

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parseTimestampFromName(name) {
  const match = name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/);
  if (!match) return null;
  const [, day, hh, mm, ss, ms = "000"] = match;
  const date = new Date(`${day}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function backupTime(filePath, dirent) {
  return parseTimestampFromName(dirent.name) || fs.statSync(filePath).mtime;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function loadPatients() {
  const db = new DatabaseSync(DB_PATH);
  try {
    const rows = db.prepare("SELECT data_json FROM patients ORDER BY chart_no COLLATE NOCASE").all();
    return rows.map(row => JSON.parse(decrypt(row.data_json)));
  } finally {
    db.close();
  }
}

function writeBackup(records) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filename = `patients-scheduled-${timestampForFile()}.json.enc`;
  const filePath = path.join(BACKUP_DIR, filename);
  const body = encrypt(JSON.stringify(records, null, 2));
  if (!DRY_RUN) fs.writeFileSync(filePath, body, "utf8");
  return { filePath, filename, bytes: Buffer.byteLength(body, "utf8") };
}

function listBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isFile() && /^patients-.*\.json\.enc$/i.test(dirent.name))
    .map(dirent => {
      const filePath = path.join(BACKUP_DIR, dirent.name);
      return { filePath, name: dirent.name, time: backupTime(filePath, dirent), size: fs.statSync(filePath).size };
    })
    .sort((a, b) => b.time - a.time);
}

function pruneBackups() {
  const now = Date.now();
  const keepAllMs = KEEP_ALL_DAYS * 24 * 60 * 60 * 1000;
  const keepMonthlyMs = KEEP_MONTHLY_DAYS * 24 * 60 * 60 * 1000;
  const files = listBackupFiles();
  const newestByMonth = new Map();
  const deletes = [];

  for (const file of files) {
    const ageMs = now - file.time.getTime();
    if (ageMs <= keepAllMs) continue;
    if (ageMs > keepMonthlyMs) {
      deletes.push({ ...file, reason: "older-than-retention" });
      continue;
    }
    const key = monthKey(file.time);
    if (!newestByMonth.has(key)) {
      newestByMonth.set(key, file);
      continue;
    }
    deletes.push({ ...file, reason: `extra-monthly-${key}` });
  }

  for (const file of deletes) {
    if (!DRY_RUN) fs.unlinkSync(file.filePath);
  }

  return { scanned: files.length, deleted: deletes.length, deletes };
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const records = loadPatients();
  const backup = writeBackup(records);
  const prune = hasFlag("--no-prune") ? { scanned: 0, deleted: 0, deletes: [] } : pruneBackups();

  console.log(`[backup] patients=${records.length}`);
  console.log(`[backup] file=${backup.filePath}`);
  console.log(`[backup] size=${formatMb(backup.bytes)}`);
  console.log(`[backup] retention scanned=${prune.scanned} deleted=${prune.deleted}${DRY_RUN ? " dry-run" : ""}`);
  for (const item of prune.deletes.slice(0, 20)) {
    console.log(`[backup] ${DRY_RUN ? "would delete" : "deleted"} ${item.name} (${item.reason})`);
  }
  if (prune.deletes.length > 20) {
    console.log(`[backup] ... ${prune.deletes.length - 20} more`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[backup] FAILED: ${error?.stack || error}`);
  process.exit(1);
}
