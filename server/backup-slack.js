"use strict";

// Creates a plaintext Slack archive in ./slack_backups and deletes Slack text
// backups older than the retention window.
//
// Usage:
//   node server/backup-slack.js
//   node server/backup-slack.js --backup-dir "D:\clinic-slack-backups"
//   node server/backup-slack.js --retention-days 1095
//   node server/backup-slack.js --dry-run

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function readArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const SLACK_TOKEN = process.env.SLACK_TOKEN || "";
const BACKUP_DIR = path.resolve(ROOT_DIR, readArg("--backup-dir", path.join(ROOT_DIR, "slack_backups")));
const RETENTION_DAYS = Number(readArg("--retention-days", "1095"));
const DRY_RUN = hasFlag("--dry-run");

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

async function slackApi(method, params = {}) {
  if (!SLACK_TOKEN) throw new Error("SLACK_TOKEN environment variable is not set.");
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
    throw new Error(`Slack API ${method} failed: ${data?.error || response.status}`);
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

async function readSlackChannelMessages(channelId) {
  const messages = [];
  let cursor = "";
  do {
    const data = await slackApi("conversations.history", {
      channel: channelId,
      limit: 1000,
      cursor
    });
    messages.push(...(Array.isArray(data.messages) ? data.messages : []));
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return messages;
}

function ymd(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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

async function writeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filePath = path.join(BACKUP_DIR, `slack-text-backup-${timestampForFile()}.txt`);
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
          errors.push(`#${channelName} join failed: ${error.message}`);
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
      errors.push(`#${channelName} backup failed: ${error.message}`);
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
  if (!DRY_RUN) fs.writeFileSync(filePath, lines.join("\r\n"), "utf8");
  return { filePath, channels: channels.length, messages: messageCount, errors, bytes: Buffer.byteLength(lines.join("\r\n"), "utf8") };
}

function listSlackBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isFile() && /^slack-text-backup-.*\.txt$/i.test(dirent.name))
    .map(dirent => {
      const filePath = path.join(BACKUP_DIR, dirent.name);
      return { filePath, name: dirent.name, time: backupTime(filePath, dirent), size: fs.statSync(filePath).size };
    })
    .sort((a, b) => b.time - a.time);
}

function pruneBackups() {
  const now = Date.now();
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = listSlackBackups();
  const deletes = files.filter(file => now - file.time.getTime() > retentionMs)
    .map(file => ({ ...file, reason: "older-than-retention" }));
  for (const file of deletes) {
    if (!DRY_RUN) fs.unlinkSync(file.filePath);
  }
  return { scanned: files.length, deleted: deletes.length, deletes };
}

async function main() {
  const backup = await writeBackup();
  const prune = hasFlag("--no-prune") ? { scanned: 0, deleted: 0, deletes: [] } : pruneBackups();
  console.log(`[slack-backup] file=${backup.filePath}`);
  console.log(`[slack-backup] channels=${backup.channels} messages=${backup.messages} errors=${backup.errors.length}`);
  console.log(`[slack-backup] size=${(backup.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[slack-backup] retentionDays=${RETENTION_DAYS} scanned=${prune.scanned} deleted=${prune.deleted}${DRY_RUN ? " dry-run" : ""}`);
  for (const item of prune.deletes.slice(0, 20)) {
    console.log(`[slack-backup] ${DRY_RUN ? "would delete" : "deleted"} ${item.name} (${item.reason})`);
  }
  if (prune.deletes.length > 20) {
    console.log(`[slack-backup] ... ${prune.deletes.length - 20} more`);
  }
}

main().catch(error => {
  console.error(`[slack-backup] FAILED: ${error?.stack || error}`);
  process.exit(1);
});
