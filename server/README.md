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
patient count and details, and the 진료·추나·삼진 widget. All beds and their patient
information remain visible regardless of the selected doctor. Other doctors' beds
use grayscale styling and cannot be clicked; only the selected doctor's patient
information viewer opens. Selecting 전체 enables viewers for all patients. When a doctor is
selected, today's discharged count and appointment badge also show the overall totals.
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

### 장기대기 알림

설정의 **장기대기 알림**에서 원장 시술 대기 기준을 0~120분으로 저장합니다.
기본값은 15분이며, 0분은 표시와 우선순위 승격을 끕니다. 간호사가 확인하는
핫팩·물리치료·적외선·스파인 등을 포함한 모든 치료 시작 대기를 표시합니다. 기준에 도달하면
원장 시술알림·치료실 일반알림과 베드 카드에 초를 생략한 `n분대기` 배지가 주황색으로 점멸합니다.
같은 원장의 시행 가능한 시술은 **시간 체크 → 설정 기준 이상 장기대기 → 약침1·약침2 → 건부항·습부항·왕뜸·전자뜸 단독 → 침·전침 및 기타** 순으로 표시합니다.
현재 치료단계만 분류하며, 같은 순위는 대기 시작 시각이 빠른 순(동일하면 베드 번호순)입니다. 0분 설정은 장기대기 승격만 끕니다.
준비 중 알림은 모든 시행 가능 시술 뒤에, 2분 이하 준비 예정 알림은 그 뒤에 남은 시간이 짧은 순으로 표시합니다.
준비 중·준비 예정은 시간 체크나 장기대기로 승격하지 않습니다. 이 두 알림은 같은 원장의 진찰·추나 대기가 있을 때만 표시합니다.

최초 대기실 환자는 접수 시각부터 대기를 표시하며 첫 베드 배정·이름 팝업 확인 후에도
그 시간을 유지합니다. 수동으로 대기실에 복귀할 때 현재 치료단계·남은 시간·대기 시작을
보관하고, 같은 치료목록으로 재배정하면 복원합니다. 진행 중인 치료를 대기로 보내면
그 시점부터 새 대기를 시작합니다. 치료목록을 바꾼 경우에는 첫 단계부터 배정합니다.
이후 대기는 현재 치료단계 진입 시각(`stageEnteredAt`)으로 계산하며, 같은 치료단계의
베드 이동·정보 수정·완료알림 확인 시 유지합니다. 원장실/스파인실 이동 대기에도
배지를 표시하지만, 실제 방에 입실하기 전에는 원장 시술 순서에 넣지 않습니다.
진찰·추나·약침·적외선·테이핑·벤치처럼 타이머가 없는 치료는 **시행 시작**을 누르면 대기를
종료하고 시작 대기 알림에서 빠지며 **시행완료**로 다음 단계에 진행합니다. 시작은 선택 사항이며,
누르지 않고 바로 **시행완료**를 눌러도 다음 단계(마지막이면 전체 완료)로 진행합니다. 시작을 생략하면
완료까지 해당 단계의 경과시간을 대기로 계산합니다. 원장 조회 페이지는 조회 전용입니다.

초기 배정의 첫 치료가 **진찰·베드진찰**이면 fixed bed의 이름 팝업 확인과 동시에
시행 시작을 자동 기록합니다. 사이니지 호출은 유지하며, 확인 후 완료까지 장기대기에서
제외됩니다. 침·핫팩 등 타이머 치료와 그 외 무타이머 치료는 자동 시작하지 않습니다.
대기실 수동 복귀 후 진행단계를 복원한 환자도 이 초기 자동 시작 대상에서 제외합니다.

치료 중간의 이동 대기에서 원장실 또는 스파인실로 배정될 때도 이름 팝업을 생성합니다.
복귀 팝업에는 대상 치료단계를 기록하며, 확인 시 그 단계가 그대로인 경우 무타이머
치료(추나·약침4·벤치추나 등)를 시행 중으로 처리합니다. 수동 대기 복귀 후 재배정도
같이 적용합니다. 일반 베드에서 원장실·스파인실로 직접 이동하거나 교환 입실한 경우도
대상 치료단계를 기록하여 같은 자동 시행 시작 처리를 적용합니다. 스파인·SW 등 타이머 치료는 팝업 확인으로 시작하지 않으며,
기존 시작 버튼으로 수동 시작합니다. 중간 자동 이동은 새 사이니지 호출을 만들지 않습니다.

설정은 `settings/doctorLongWaitMinutes`로 모든 데스크·원장실·베드 화면에 SSE로
전파합니다. 경과시간은 기존 화면 타이머에서 계산하므로 매초 서버에 저장하지 않습니다.
타이머 시작 시 해당 치료단계의 시작 상태를 저장하므로, 이후 일시정지는 새 치료를
기다리는 상태로 취급하지 않습니다. 다음 치료단계에서는 이 상태를 지우고 새 대기를 계산합니다.

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

### Appointment imports

Desk's **오늘 N명 → 예약 불러오기** reads the complete Donguibogam `.xls` / `.xlsx`
appointment export. The preview shows date totals and added, removed and changed
patients. Applying replaces only the dates present in the file; export the full
roster for each date. To clear a date with no bookings, select it explicitly in
the import popup and apply its zero-patient preview.

Bookings are stored as encrypted daily snapshots in `appointment_snapshots`,
separately from bed date requests and patient clinical records. Counts deduplicate
patients by chart number and name while preserving all time/doctor slots. The
calendar is read-only and shows the source filename and last import time.
Other desks refresh over the existing SSE connection. Concurrent changes reject
outdated previews; previous snapshots are retained encrypted in
`appointment_import_log` for recovery.

Dates without an imported snapshot continue to show existing manual bookings.
An imported snapshot replaces the roster for its date only, including an explicit
zero-patient snapshot. Patient visit history and the old manual booking fields are
preserved. Existing `appointment_settings.cutoverDate` values are no longer used.

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
