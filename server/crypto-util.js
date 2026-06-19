"use strict";

// Encryption-at-rest helper for the clinic local server.
//
// - Algorithm: AES-256-GCM (authenticated encryption; detects tampering).
// - Only Node built-ins are used (no extra dependencies).
// - Encrypted values are tagged with the ENC_PREFIX so plaintext rows written
//   before encryption was enabled keep working (decrypt() passes them through),
//   which lets us migrate the DB with zero downtime.
//
// KEY HANDLING — the single most important rule:
//   The key must NEVER live inside the backup folder or anything that is synced
//   to Google Drive / OneDrive. If the key and the ciphertext leak together the
//   encryption is worthless. Default location is OUTSIDE the project tree.
//
//   Override with env vars when needed:
//     CLINIC_KEY_PATH=D:\some\path\key.bin   (file holding 32 raw bytes)
//     CLINIC_KEY_HEX=<64 hex chars>          (key inline, takes precedence)

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ENC_PREFIX = "enc:v1:";
const KEY_PATH = process.env.CLINIC_KEY_PATH || "C:\\clinic-secret\\key.bin";

function loadOrCreateKey() {
  if (process.env.CLINIC_KEY_HEX) {
    const key = Buffer.from(process.env.CLINIC_KEY_HEX, "hex");
    if (key.length !== 32) {
      throw new Error("CLINIC_KEY_HEX must be 32 bytes (64 hex characters)");
    }
    return key;
  }

  if (fs.existsSync(KEY_PATH)) {
    const key = fs.readFileSync(KEY_PATH);
    if (key.length !== 32) {
      throw new Error(`Key file ${KEY_PATH} must be exactly 32 bytes`);
    }
    return key;
  }

  // First run: generate a fresh key and persist it outside the synced folders.
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key);
  console.log(`[crypto] New AES-256 key generated at ${KEY_PATH}`);
  console.log("[crypto] !! BACK THIS KEY UP SOMEWHERE SAFE (offline/USB/password manager).");
  console.log("[crypto] !! Losing it makes every encrypted backup and DB row UNRECOVERABLE.");
  console.log("[crypto] !! Do NOT place it in the backup folder or any cloud-synced directory.");
  return key;
}

const KEY = loadOrCreateKey();

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

// Encrypts a UTF-8 string. Output layout (base64): [12B IV][16B GCM tag][ciphertext].
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

// Decrypts a value produced by encrypt(). Plain (non-prefixed) strings are
// returned unchanged so legacy rows and pre-encryption data still load.
function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt, isEncrypted, ENC_PREFIX, KEY_PATH };
