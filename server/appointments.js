'use strict';
const crypto = require('node:crypto');
const appointmentImport = require('../appointment-import');

function createStore(db, { encrypt, decrypt }) {
  db.exec(`CREATE TABLE IF NOT EXISTS appointment_snapshots (
    date TEXT PRIMARY KEY, data_json TEXT NOT NULL, source_file TEXT NOT NULL,
    imported_at TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS appointment_import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, imported_at TEXT NOT NULL, previous_json TEXT NOT NULL);`);
  const pending = new Map();
  const read = date => {
    const row = db.prepare('SELECT * FROM appointment_snapshots WHERE date=?').get(date);
    return row ? { ...row, entries: JSON.parse(decrypt(row.data_json)) } : null;
  };
  function list(start, end) {
    return db.prepare('SELECT * FROM appointment_snapshots WHERE date>=? AND date<=? ORDER BY date').all(start, end)
      .map(row => ({ date: row.date, sourceFile: row.source_file, importedAt: row.imported_at, revision: row.revision,
        entries: JSON.parse(decrypt(row.data_json)) }));
  }
  function preview(body) {
    for (const [token, item] of pending) if (item.expiresAt < Date.now()) pending.delete(token);
    if (pending.size >= 100) { const error = Error('진행 중인 불러오기가 많습니다. 잠시 후 다시 시도해주세요'); error.statusCode = 429; throw error; }
    const groups = appointmentImport.validate(body.entries, body.clearDates || []);
    const sourceFile = appointmentImport.text(body.sourceFile || '날짜 지정 비우기').slice(0, 255);
    const revisions = groups.map(group => read(group.date)?.revision || 0);
    const dates = groups.map(group => ({ date: group.date, ...appointmentImport.compare(read(group.date)?.entries || [], group.entries) }));
    const token = crypto.randomUUID();
    pending.set(token, { groups, sourceFile, revisions, expiresAt: Date.now() + 10 * 60 * 1000 });
    return { token, dates, sourceFile };
  }
  function commit(token) {
    const item = pending.get(token);
    if (!item || item.expiresAt < Date.now()) { pending.delete(token); const error = Error('미리보기가 만료되었습니다. 파일을 다시 선택해주세요'); error.statusCode = 409; throw error; }
    const stamp = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = item.groups.map(group => read(group.date));
      if (previous.some((row, index) => (row?.revision || 0) !== item.revisions[index])) {
        const error = Error('다른 데스크에서 해당 날짜의 명단을 변경했습니다. 다시 불러와 확인해주세요'); error.statusCode = 409; throw error;
      }
      writeGroups(item.groups, item.sourceFile, stamp, previous);
      db.exec('COMMIT');
      pending.delete(token);
      return { ok: true, importedAt: stamp, dates: item.groups.map(group => group.date) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function writeGroups(groups, sourceFile, stamp, previous) {
    db.prepare('INSERT INTO appointment_import_log(source_file,imported_at,previous_json) VALUES(?,?,?)')
      .run(sourceFile, stamp, encrypt(JSON.stringify(previous)));
    const write = db.prepare(`INSERT INTO appointment_snapshots VALUES(?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET
      data_json=excluded.data_json,source_file=excluded.source_file,imported_at=excluded.imported_at,revision=excluded.revision`);
    groups.forEach((group, i) => write.run(group.date, encrypt(JSON.stringify(group.entries)),
      sourceFile, stamp, (previous[i]?.revision || 0) + 1));
  }
  // Same date replacement as manual Excel, in the caller's SQLite transaction.
  // Dates absent from the result are NOT implicitly cleared (as with Excel).
  function replaceFromBogam(groups, stamp) {
    if (!groups.length) return;
    const validated = appointmentImport.validate(groups.flatMap(group => group.entries));
    writeGroups(validated, '동의보감 직접 조회 (엑셀 방식 교체)', stamp, validated.map(group => read(group.date)));
  }
  return { read, list, preview, commit, replaceFromBogam };
}
module.exports = { createStore };
