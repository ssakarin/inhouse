'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { buildQuery, accountSql, schemaSql, principalsSql } = require('./queries');
const { normalize, ranges, failure } = require('../server/bogam-sync');

function execute(query, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'query.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false, expired = false;
    const abort = () => { expired = true; child.kill(); };
    const timer = setTimeout(abort, 12000);
    if (signal) signal.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { output += text; if (Buffer.byteLength(output) > 8 * 1024 * 1024) abort(); });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(failure('SOURCE_REJECTED', 502)));
    // Keep the lock until the SQL process has actually exited, including cancellation.
    child.on('close', () => {
      if (expired) return finish(failure('SYNC_TIMEOUT', 504));
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, ''));
        if (!result.ok) return finish(failure(result.code === 'SYNC_TIMEOUT' ? 'SYNC_TIMEOUT' : 'SOURCE_REJECTED', 502));
        finish(null, result.sets);
      } catch { finish(failure('SOURCE_REJECTED', 502)); }
    });
    child.stdin.end(JSON.stringify(query));
  });
}

function sourceResult(sets, requested, config, dryRun, elapsedMs) {
  if (!Array.isArray(sets) || sets.length !== 3 || !sets.every(Array.isArray)) throw failure('INVALID_SOURCE_DATA');
  const [audit, visits, bookings] = sets;
  if (visits.length > 10000 || bookings.length > 10000) throw failure('INVALID_SOURCE_DATA');
  const readOnlyVerified = audit[0]?.readOnlyVerified === true;
  if (!dryRun && !readOnlyVerified) throw failure('READ_ONLY_ACCOUNT_REQUIRED', 403);
  let unmappedDoctors = 0;
  const map = row => {
    const doctorName = typeof row.doctorName === 'string' ? row.doctorName.trim() : '';
    if (!doctorName) unmappedDoctors++;
    const { doctorCode, ...fields } = row;
    return { ...fields, doctorName: doctorName || (dryRun ? '미매핑' : '') };
  };
  const payload = { visits: visits.map(map), bookings: bookings.map(map) };
  if (!dryRun && unmappedDoctors) throw failure('UNMAPPED_DOCTOR', 409);
  // Even dry-run validates dates, identities, duplicates, row caps and all confirmed fields.
  normalize(payload, requested);
  const counts = { visits: visits.length, bookings: bookings.length, unmappedDoctors };
  return dryRun ? { ok: true, dryRun: true, counts, elapsedMs, readOnlyVerified }
    : { ok: true, dryRun: false, ...payload, counts, elapsedMs, readOnlyVerified };
}

function createHandler(config, query = execute) {
  let busy = false;
  const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
  if (!/^[a-f0-9]{64,128}$/i.test(token)) throw Error('Invalid token');
  const send = (res, status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
  return async (req, res) => {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const provided = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (ip !== config.allowedClientIp || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      send(res, 403, { code: 'FORBIDDEN' }); return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/query') { send(res, 404, { code: 'NOT_FOUND' }); return; }
    if (busy) { send(res, 409, { code: 'SYNC_BUSY' }); return; }
    busy = true;
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', disconnected);
    const started = Date.now();
    try {
      let raw = '';
      const bodyTimer = setTimeout(() => req.destroy(), 3000);
      try { for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw failure('INVALID_RANGE'); } }
      finally { clearTimeout(bodyTimer); }
      const body = JSON.parse(raw), requested = ranges(body);
      const dryRun = body.dryRun !== false || config.applyEnabled !== true;
      const sets = await query(buildQuery(requested, config), { signal: abort.signal });
      send(res, 200, sourceResult(sets, requested, config, dryRun, Date.now() - started));
    } catch (error) {
      const codes = ['SYNC_TIMEOUT','READ_ONLY_ACCOUNT_REQUIRED','UNMAPPED_DOCTOR','SOURCE_NOT_CONFIGURED','INVALID_RANGE'];
      send(res, error.statusCode || 502, { code: codes.includes(error.code) ? error.code : 'SOURCE_REJECTED' });
    } finally { res.removeListener('close', disconnected); busy = false; }
  };
}

async function main() {
  const file = process.env.BOGAM_BRIDGE_CONFIG;
  if (!file) throw Error('Set BOGAM_BRIDGE_CONFIG to an external config file');
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (process.argv.includes('--inspect')) {
    const sets = await execute({ sql: `${accountSql};${schemaSql};${principalsSql}`, parameters: {} });
    // Metadata only; never patient rows, SQL credentials or token values.
    console.log(JSON.stringify({ account: sets[0], columns: sets[1], visiblePrincipals: sets[2] }, null, 2)); return;
  }
  if (process.argv.includes('--check')) {
    const start = process.argv[process.argv.indexOf('--check') + 1], end = process.argv[process.argv.indexOf('--check') + 2];
    const requested = ranges({ visits: { start, end }, bookings: { start, end } });
    const started = Date.now();
    const sets = await execute(buildQuery(requested, config));
    console.log(JSON.stringify(sourceResult(sets, requested, config, true, Date.now() - started))); return;
  }
  if (!config.listenHost || !config.allowedClientIp || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('Invalid bridge listener configuration');
  const server = https.createServer({ pfx: fs.readFileSync(config.pfxFile),
    passphrase: fs.readFileSync(config.pfxPasswordFile, 'utf8').trim(), minVersion: 'TLSv1.2' }, createHandler(config));
  server.requestTimeout = 18000; server.headersTimeout = 5000; server.maxConnections = 8;
  server.listen(config.port, config.listenHost, () => console.log('Bogam SELECT bridge ready. Queries run only on demand.'));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
if (require.main === module) main().catch(error => {
  const code = ['SYNC_TIMEOUT','SOURCE_NOT_CONFIGURED','READ_ONLY_ACCOUNT_REQUIRED','UNMAPPED_DOCTOR','INVALID_RANGE','INVALID_SOURCE_DATA','AMBIGUOUS_SOURCE_DATA'].includes(error.code)
    ? error.code : 'SOURCE_REJECTED';
  console.error(`Bogam bridge stopped: ${code}. No patient data logged.`); process.exitCode = 1;
});
module.exports = { execute, sourceResult, createHandler };
