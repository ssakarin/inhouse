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

`/doctor` opens the desk layout with an **전체 / 원장** selector populated from
staff settings. The selected doctor scopes the waiting list, alerts, discharged
patient count and details, and the 진료·추나·삼진 widget. Beds assigned to other
doctors and unassigned beds are dimmed and disabled; **전체** restores all beds.
The doctor page is read-only: patient cards open an information viewer, and
bed movement, editing, automatic assignment, timer completion and nightly cleanup
do not run from this page. HTTP mutation requests are blocked in the doctor UI.
This is a UI restriction, not an authentication or server authorization boundary.
Selection is saved on the device and can also be shared as
`/doctor?doctor=STAFF_ID` (`doctor=` explicitly selects 전체).

Weekly doctor metrics use each visit's recorded doctor. Return/third-visit
cohorts belong to the doctor who saw the initial visit, matching the overall
widget's follow-up definition. `/api/dashboard/weekly?days=14&doctor=원장이름`
returns the scoped metrics; omitting `doctor` returns the overall metrics.

Windows Firewall may ask for permission. Allow private network access.

## Data

SQLite DB:

```text
server/data/clinic.db
```

Automatic safety backups:

```text
C:\backup\server
```

Slack text backups:

```text
C:\backup\slack
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
node server/decrypt-backup.js C:\backup\server\patients-<...>.json.enc out.json
```

`out.json` is plaintext PII ??delete it once you are done.

## Authentication

Device login is disabled by default, so tablets/desks can open the app directly.
To re-enable shared-password login, set both env vars before starting the server:

- `CLINIC_REQUIRE_LOGIN=1`
- `CLINIC_PASSWORD` - login password

Delete-all confirmation is separate and remains protected:

- `CLINIC_DELETE_PASSWORD` - delete-all confirmation password (default `337758`)

> Note: traffic is plain HTTP. If shared-password login is re-enabled, use HTTPS or a trusted local network.

## Local mode

When `index.html` is opened through this local server:

- Patient DB screens (`db-viewer.html`, `stats.html`) read/write the local SQLite DB.
- Real-time bed state is stored in encrypted `app_state`.
- Timer and bed-state changes are pushed to connected clients through SSE.

## 기간 요약 데이터 추출 (stats.html)

`stats.html`의 "주간/월간/분기 요약" 버튼을 누르면 기간 요약·기간 추이·기간 비교·시간대별 환자 수
데이터(전체 + 원장별)를 텍스트로 모아 모달에 보여줍니다. 환자 개인정보는 포함되지 않습니다.
API 키나 과금 없이, "데이터 복사" 버튼으로 복사한 뒤 Claude.ai(기존 로그인 계정) 등에 붙여넣어
분석을 요청하는 방식입니다.

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
- `GET /api/ai/period-summary-prompt` - 기간 요약 데이터 추출 텍스트 생성 (`?period=week|month|quarter`)

Import accepts either a JSON array or:

```json
{
  "mode": "merge",
  "patients": []
}
```

Use `"mode": "replace"` only when intentionally replacing all server patients.

## 수기차트 일별 통계

stats.html의 “수기차트 일별 자료”에서 기존 지표관리 XLS/XLSX 파일을 선택하고 기간·일수를 확인한 뒤 서버에 저장합니다. 일간데이터 합계행(AQ=Y)을 우선 읽고, 해당 시트가 없으면 Raw Data를 읽습니다.

저장 항목은 본인부담금, 공단청구금, 비급여, 자보, 예약 환자수, 정상 이행, 노쇼, 취소 및 유입경로뿐입니다. 환자 수·연령·상품별 매출 등 다른 항목은 저장하지 않습니다. 같은 날짜는 해당 날짜의 새 자료로 교체하며 공란은 진료보드 보충 대상, 명시된 0은 확정값입니다. 이전 날짜별 자료는 암호화된 가져오기 이력에 보존합니다.

전체 원장 조회의 매출과 금액 추이는 날짜별 자료를 우선 사용합니다. 원장별·환자별 분석 및 다른 보고서에는 환자 기록을 사용합니다. 날짜별 합계가 적용된 기간에는 환자당 금액을 계산하지 않습니다. 예약·유입경로 공란은 자료 없음이며 자동으로 0으로 바꾸지 않습니다.

서버 API: GET /api/daily-metrics?start=YYYY-MM-DD&end=YYYY-MM-DD, POST /api/daily-metrics ({rows, sourceFile}). SQLite의 daily_clinic_metrics에 날짜별 자료를 암호화 저장하며 daily_clinic_metrics_imports에 변경 이력을 남깁니다.

비급여 상세 가져오기: 엑셀 및 구글시트에서 `금액_최초결제`/`금액_재결제` 제목으로 금액 열을 찾고, 각 금액 열에서 4열 앞의 항목명(AG/AL)을 사용합니다. 날짜가 공란인 상세행은 직전 날짜에 속하며, 같은 항목명(공백 제거)의 최초·재결제 금액을 합산해 `nonCoveredBreakdown`에 암호화 저장합니다. 비급여 총액은 기존 `비급여매출` 값을 유지합니다. 구글 미리보기에는 항목별 변경을 표시하고 기존 상세의 공란 항목은 보존합니다.

실제 v26 양식의 금액 제목 `비급여 합계` 및 `비급여합계_재결제`도 지원합니다. 취합 Y 합계행은 상세 합산에서 제외하며, 재결제 항목명 끝의 `재결제`를 제거해 같은 항목으로 합산합니다.
