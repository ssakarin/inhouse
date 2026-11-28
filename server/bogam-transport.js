'use strict';
const fs = require('node:fs');
const https = require('node:https');
const { failure } = require('./bogam-sync');

function loadConfig(file) {
  if (!file) return { enabled: false, applyEnabled: false };
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (config.enabled !== true) return { enabled: false, applyEnabled: false };
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid Bogam bridge URL');
  const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
  if (!/^[a-f0-9]{64,128}$/i.test(token)) throw Error('Invalid Bogam bridge token');
  return { enabled: true, applyEnabled: config.applyEnabled === true,
    url, token, ca: fs.readFileSync(config.caFile) };
}
function createTransport(config, request = https.request) {
  return body => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const req = request(new URL('/v1/query', config.url), { method: 'POST', ca: config.ca,
      rejectUnauthorized: true, headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
        Authorization: `Bearer ${config.token}` } }, res => {
      let length = 0, chunks = [];
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) { finish(failure('INVALID_SOURCE_DATA', 502)); res.destroy(); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on('error', () => finish(failure('DESK_UNREACHABLE', 502)));
      res.on('aborted', () => finish(failure('DESK_UNREACHABLE', 502)));
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) {
            const codes = ['SYNC_TIMEOUT', 'SYNC_BUSY', 'READ_ONLY_ACCOUNT_REQUIRED', 'UNMAPPED_DOCTOR', 'SOURCE_NOT_CONFIGURED'];
            finish(failure(codes.includes(result.code) ? result.code : 'SOURCE_REJECTED', res.statusCode === 409 ? 409 : 502));
          } else finish(null, result);
        } catch { finish(failure('INVALID_SOURCE_DATA', 502)); }
      });
    });
    const timer = setTimeout(() => { finish(failure('SYNC_TIMEOUT', 504)); req.destroy(); }, 16000);
    req.on('error', () => finish(failure('DESK_UNREACHABLE', 502)));
    req.end(bytes);
  });
}
module.exports = { loadConfig, createTransport };
