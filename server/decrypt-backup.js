"use strict";

// Decrypts an encrypted backup file (patients-*.json.enc) back to plain JSON.
//
// Usage:
//   node server/decrypt-backup.js <file.json.enc>            # print to stdout
//   node server/decrypt-backup.js <file.json.enc> out.json   # write to a file
//
// Uses the same key as the server (C:\clinic-secret\key.bin by default, or the
// CLINIC_KEY_PATH / CLINIC_KEY_HEX env vars). The decrypted output contains
// plaintext patient PII — handle it carefully and delete it when done.

const fs = require("node:fs");
const { decrypt, isEncrypted } = require("./crypto-util");

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath) {
  console.error("Usage: node server/decrypt-backup.js <file.json.enc> [out.json]");
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8").trim();

if (!isEncrypted(raw)) {
  // Already plaintext (e.g. an old backup written before encryption was added).
  console.error("[decrypt-backup] File is not encrypted; passing through unchanged.");
}

const plain = isEncrypted(raw) ? decrypt(raw) : raw;

if (outputPath) {
  fs.writeFileSync(outputPath, plain, "utf8");
  console.error(`[decrypt-backup] Wrote ${outputPath}`);
} else {
  process.stdout.write(plain);
}
