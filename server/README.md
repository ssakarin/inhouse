# Inhouse Local Server

This is the first local-server version for sharing the app on the same Wi-Fi.

## Start

From the project root:

```powershell
.\start-server.bat
```

Then open:

```text
http://127.0.0.1:8787/
http://127.0.0.1:8787/db-viewer.html
http://127.0.0.1:8787/stats.html
```

Other PCs on the same Wi-Fi can open:

```text
http://SERVER_PC_IP:8787/
```

Windows Firewall may ask for permission. Allow private network access.

## Data

SQLite DB:

```text
server/data/clinic.db
```

Automatic safety backups:

```text
server/backups/
```

Slack text backups:

```text
slack_backups/
```

These files are intentionally ignored by git.

### Scheduled backups

Patient DB daily backup:

```powershell
.\register-daily-backup-task.ps1
```

Slack backup every 3 months, deleting Slack text backups older than 3 years:

```powershell
.\register-slack-backup-task.ps1
```

Slack backup requires `SLACK_TOKEN` in the user or system environment.

## Encryption at rest

Patient records (`data_json`), `app_state`, and every backup file are encrypted
with AES-256-GCM before being written to disk. Backups are saved as
`*.json.enc`, so the JSON pushed to Google Drive is ciphertext, not plaintext.

The 32-byte key is read from (in order):

1. `CLINIC_KEY_HEX` env var (64 hex chars), if set
2. `CLINIC_KEY_PATH` env var, if set
3. `C:\clinic-secret\key.bin` (default; auto-generated on first run)

IMPORTANT:

- The key must NOT live in the backup folder or any cloud-synced directory
  (OneDrive / Google Drive). Keep it on the local machine only.
- Back the key up separately (offline USB / password manager). If it is lost,
  all encrypted backups and DB rows become permanently unrecoverable.
- Existing plaintext rows are encrypted automatically on server startup.

### Restoring / reading a backup

```powershell
node server/decrypt-backup.js server/backups/patients-<...>.json.enc out.json
```

`out.json` is plaintext PII — delete it once you are done.

## Authentication

Every page and API requires login with a shared password.

- First visit on a device redirects to `/login`. After entering the password the
  server sets an HttpOnly session cookie, so each device only logs in once
  (cookie lasts 1 year; sessions survive server restarts).
- `GET /api/*` without a valid session returns `401`; page requests redirect to
  `/login`. Static assets (js/css/img/manifest) load without auth so the login
  page and PWA shell work.
- `POST /api/logout` clears the session.

Passwords come from env vars (defaults are used if unset — change them in
production):

- `CLINIC_PASSWORD` — login password (default `7677`)
- `CLINIC_DELETE_PASSWORD` — delete-all confirmation password (default `7677`)

> Note: traffic is plain HTTP, so a determined sniffer on the same Wi-Fi can
> still capture the session cookie. For full protection, terminate HTTPS (a
> self-signed cert or a reverse proxy) in front of the server.

## Local mode

When `index.html` is opened through this local server:

- Patient DB screens (`db-viewer.html`, `stats.html`) read/write the local SQLite DB.
- Real-time bed state is stored in encrypted `app_state`.
- Timer and bed-state changes are pushed to connected clients through SSE.

## API

- `GET /api/health`
- `GET /api/patients`
- `POST /api/patients`
- `GET /api/patients/:chartNo`
- `PUT /api/patients/:chartNo`
- `DELETE /api/patients/:chartNo`
- `POST /api/import/patients`
- `GET /api/export/patients`
- `GET /api/state/:key`
- `PUT /api/state/:key`
- `DELETE /api/state/:key`

Import accepts either a JSON array or:

```json
{
  "mode": "merge",
  "patients": []
}
```

Use `"mode": "replace"` only when intentionally replacing all server patients.
