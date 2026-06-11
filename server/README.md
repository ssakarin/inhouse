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

These files are intentionally ignored by git.

## Hybrid mode

When `index.html` is opened through this local server:

- Patient DB screens (`db-viewer.html`, `stats.html`) read/write the local SQLite DB.
- Real-time bed state normally uses Firebase.
- If Firebase disconnects, the latest bed snapshot is loaded from `app_state`.
- Timer and bed-state changes made during local fallback are saved to `app_state`.
- When Firebase reconnects, pending local bed-state changes are pushed back to Firebase.

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
