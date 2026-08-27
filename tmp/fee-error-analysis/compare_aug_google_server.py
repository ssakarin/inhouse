import base64, json, sqlite3, time, urllib.parse, urllib.request
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

SERVICE = Path(r"C:\Users\Hippo\OneDrive\문서\3rd_visit_check\service_account.json")
DB = Path(r"C:\Users\Hippo\OneDrive\바탕 화면\inhouse\server\data\clinic.db")
SHEET_ID = "1ai2Feihd-MbEzD6bTqaumJsfvRMpVJcYPiEdcCbK3CU"
TAB = "일간데이터"
START, END = "2026-08-01", "2026-08-20"

def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")

account = json.loads(SERVICE.read_text(encoding="utf-8"))
now = int(time.time())
unsigned = b64({"alg":"RS256","typ":"JWT"}) + "." + b64({
    "iss": account["client_email"], "scope":"https://www.googleapis.com/auth/spreadsheets.readonly",
    "aud":"https://oauth2.googleapis.com/token", "iat":now, "exp":now+3600
})
key = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
sig = key.sign(unsigned.encode(), padding.PKCS1v15(), hashes.SHA256())
assertion = unsigned + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")
body = urllib.parse.urlencode({"grant_type":"urn:ietf:params:oauth:grant-type:jwt-bearer","assertion":assertion}).encode()
req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body, headers={"Content-Type":"application/x-www-form-urlencoded"})
token = json.loads(urllib.request.urlopen(req).read())["access_token"]
sheet_range = urllib.parse.quote(f"'{TAB}'!A:AQ", safe="")
url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{sheet_range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE"
req = urllib.request.Request(url, headers={"Authorization":f"Bearer {token}"})
rows = json.loads(urllib.request.urlopen(req).read()).get("values", [])

def cell(row, idx): return row[idx] if idx < len(row) else ""
def num(v):
    s = str(v or "").replace(",", "").replace(" ", "").replace("₩", "")
    if s in ("", "-", "–"): return 0
    try: return float(s.replace("%", ""))
    except: return 0

# Aggregate rows are marked Y in AQ. Fall back to the first row for each date.
google = {}
for row_no, row in enumerate(rows, 1):
    date = str(cell(row, 1))
    if START <= date <= END and (date not in google or str(cell(row, 42)).strip() == "Y"):
        google[date] = {
            "row": row_no, "당일 환자수":num(cell(row,3)), "신규 환자수":num(cell(row,4)),
            "재진 환자수":num(cell(row,5)), "재초진 환자수":num(cell(row,6)), "자보 초진 환자수":num(cell(row,7)),
            "총 진료비":num(cell(row,25)), "본인 부담금":num(cell(row,26)), "공단 청구금":num(cell(row,27)),
            "비급여 매출":num(cell(row,28)), "자보 매출":num(cell(row,29)), "기타 진료비":num(cell(row,30)),
        }

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
types = [dict(x) for x in db.execute("select coalesce(visit_type,'') visit_type,count(*) count from patient_visits where visit_date between ? and ? group by visit_type order by count desc", (START,END))]
query = """
select pv.visit_date,
 count(*) visits,
 sum(case when coalesce(pv.visit_type,'') like '%초진%' and coalesce(pv.visit_type,'') not like '%재초진%' then 1 else 0 end) new_visits,
 sum(case when coalesce(pv.visit_type,'') like '%재진%' and coalesce(pv.visit_type,'') not like '%재초진%' then 1 else 0 end) revisit_visits,
 sum(case when coalesce(pv.visit_type,'') like '%재초진%' then 1 else 0 end) restart_visits,
 sum(case when (coalesce(p.insurance_type,'') like '%자동차%' or coalesce(p.insurance_type,'') like '%자보%') and coalesce(pv.visit_type,'') like '%초진%' then 1 else 0 end) auto_new,
 sum(coalesce(pv.total_fee,0) + coalesce(pv.noncovered_amount,0)) total_all,
 sum(coalesce(pv.insured_copay,0)) copay,
 sum(case when coalesce(p.insurance_type,'') not like '%자동차%' and coalesce(p.insurance_type,'') not like '%자보%' then coalesce(pv.claim_amount,0) else 0 end) claim_regular,
 sum(coalesce(pv.noncovered_amount,0)) noncovered,
 sum(case when coalesce(p.insurance_type,'') like '%자동차%' or coalesce(p.insurance_type,'') like '%자보%' then coalesce(pv.total_fee,0) else 0 end) auto_fee
from patient_visits pv left join patients p on p.patient_id=pv.patient_id
where pv.visit_date between ? and ? group by pv.visit_date order by pv.visit_date
"""
server = {}
for r in db.execute(query, (START, END)):
    server[r["visit_date"]] = {
        "당일 환자수":r["visits"], "신규 환자수":r["new_visits"], "재진 환자수":r["revisit_visits"],
        "재초진 환자수":r["restart_visits"], "자보 초진 환자수":r["auto_new"], "총 진료비":r["total_all"],
        "본인 부담금":r["copay"], "공단 청구금":r["claim_regular"], "비급여 매출":r["noncovered"], "자보 매출":r["auto_fee"],
    }

metrics = ["당일 환자수","신규 환자수","재진 환자수","재초진 환자수","자보 초진 환자수","총 진료비","본인 부담금","공단 청구금","비급여 매출","자보 매출"]
result = {}
for metric in metrics:
    details=[]
    for date in sorted(set(google)&set(server)):
        gv=float(google[date].get(metric,0)); sv=float(server[date].get(metric,0)); diff=sv-gv
        details.append({"date":date,"google":gv,"server":sv,"diff":diff,"abs_pct":abs(diff)/abs(gv)*100 if gv else (0 if sv==0 else None)})
    gs=sum(x["google"] for x in details); ss=sum(x["server"] for x in details); dif=ss-gs
    valid=sorted(x["abs_pct"] for x in details if x["abs_pct"] is not None)
    result[metric]={"google_total":gs,"server_total":ss,"diff":dif,"aggregate_signed_pct":dif/gs*100 if gs else None,
        "aggregate_abs_pct":abs(dif)/abs(gs)*100 if gs else None,"matching_days":sum(x["diff"]==0 for x in details),
        "compared_days":len(details),"daily_median_abs_pct":valid[len(valid)//2] if valid else None,
        "daily_max_abs_pct":max(valid) if valid else None,"largest":sorted(details,key=lambda x:(x["abs_pct"] is not None, x["abs_pct"] or -1),reverse=True)[:5]}

print(json.dumps({"range":[START,END],"google_dates":len(google),"server_dates":len(server),"visit_types":types,"metrics":result},ensure_ascii=False,indent=2))
