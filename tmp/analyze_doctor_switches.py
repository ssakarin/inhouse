import json, urllib.request, hashlib, sys
from collections import Counter, defaultdict
from datetime import date

START, END = "2026-04-01", "2026-08-08"
URL = "http://127.0.0.1:8787/api/patients"

with urllib.request.urlopen(URL, timeout=60) as resp:
    patients = json.load(resp)

def doctor(v):
    s = str((v or {}).get("doctorName", "")).strip().replace(" ", "")
    if "허진혁" in s: return "허진혁"
    if "김상준" in s: return "김상준"
    return ""

def mask_chart(p):
    raw = str(p.get("chartNo") or p.get("patientId") or "")
    tail = raw[-4:] if len(raw) >= 4 else raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:5]
    return f"***{tail}-{digest}"

all_visits=[]
doc_raw=Counter(); type_raw=Counter()
patient_sequences=[]
for p in patients:
    hist = p.get("visitHistory") or {}
    seq_all=[]
    for d,v in hist.items():
        vt=str((v or {}).get("visitType", "")).strip()
        doc=doctor(v)
        if not doc or "약환" in vt: continue
        seq_all.append({"date":str(d),"doctor":doc,"visitType":vt})
    seq_all.sort(key=lambda x:x["date"])
    for i,x in enumerate(seq_all): x["globalOrdinal"] = i+1
    seq=[x for x in seq_all if START <= x["date"] <= END]
    if seq:
        for x in seq:
            doc_raw[x["doctor"]] += 1
            type_raw[x["visitType"]] += 1
        patient_sequences.append((p,seq))
        all_visits.extend(seq)

switch_events=[]
switch_patients=set()
case_rows=[]
for p,seq in patient_sequences:
    changes=[]
    for i in range(1,len(seq)):
        a,b=seq[i-1],seq[i]
        if a["doctor"] == b["doctor"]: continue
        direction=f'{a["doctor"]}->{b["doctor"]}'
        weekday=date.fromisoformat(b["date"]).weekday() # Mon=0
        # Temporary coverage: A->B and immediate next valid visit returns to A.
        returns = i+1 < len(seq) and seq[i+1]["doctor"] == a["doctor"]
        # Continued transfer: the next visit, if observed, remains with B.
        continues = i+1 < len(seq) and seq[i+1]["doctor"] == b["doctor"]
        ev={
            "patient":mask_chart(p), "direction":direction,
            "fromDate":a["date"], "toDate":b["date"],
            "destinationOrdinalWithinPeriod":i+1,
            "destinationGlobalOrdinal":b["globalOrdinal"],
            "destinationVisitType":b["visitType"],
            "toTuesday": weekday==1,
            "immediateReturn":returns,
            "continuedNewDoctor":continues,
            "nextDoctor":seq[i+1]["doctor"] if i+1 < len(seq) else "관찰없음",
            "nextDate":seq[i+1]["date"] if i+1 < len(seq) else "",
        }
        switch_events.append(ev); changes.append(ev)
    if changes:
        switch_patients.add(mask_chart(p))
        case_rows.append({"patient":mask_chart(p),"visits":len(seq),"firstDoctor":seq[0]["doctor"],"lastDoctor":seq[-1]["doctor"],"changes":changes})

direction=Counter(e["direction"] for e in switch_events)
dest_ord=Counter(e["destinationOrdinalWithinPeriod"] for e in switch_events)
dest_global_ord=Counter(e["destinationGlobalOrdinal"] for e in switch_events)
dest_type=Counter(e["destinationVisitType"] or "미기재" for e in switch_events)
tuesday=Counter(e["direction"] for e in switch_events if e["toTuesday"])
temporary=Counter(e["direction"] for e in switch_events if e["immediateReturn"])
continued=Counter(e["direction"] for e in switch_events if e["continuedNewDoctor"])
last_observed=Counter(e["direction"] for e in switch_events if e["nextDoctor"]=="관찰없음")
per_patient_change_count=Counter(len(c["changes"]) for c in case_rows)

monthly=defaultdict(Counter)
for e in switch_events:
    monthly[e["toDate"][:7]][e["direction"]]+=1

# Run-level interpretation of Tuesday Kim -> Heo changes.
tue_kh=[e for e in switch_events if e["direction"]=="김상준->허진혁" and e["toTuesday"]]
tue_kh_dates=Counter(e["toDate"] for e in tue_kh)
tue_kh_immediate=sum(e["immediateReturn"] for e in tue_kh)
tue_kh_eventual=0; tue_kh_sustained=0; tue_kh_censored=0
coverage_return_hk=0
for p,seq in patient_sequences:
    for i in range(1,len(seq)):
        a,b=seq[i-1],seq[i]
        if a["doctor"]=="김상준" and b["doctor"]=="허진혁" and date.fromisoformat(b["date"]).weekday()==1:
            later=seq[i+1:]
            if any(x["doctor"]=="김상준" for x in later): tue_kh_eventual += 1
            elif later: tue_kh_sustained += 1
            else: tue_kh_censored += 1
        if a["doctor"]=="허진혁" and b["doctor"]=="김상준":
            # Walk back to the start of the immediately preceding Heo run.
            j=i-1
            while j>0 and seq[j-1]["doctor"]=="허진혁": j-=1
            if j>0 and seq[j-1]["doctor"]=="김상준" and date.fromisoformat(seq[j]["date"]).weekday()==1:
                coverage_return_hk += 1

# First-to-last doctor movement per patient in the analysis window.
first_last=Counter()
switch_first_last=Counter()
net_change_evidence=Counter()
confirmed_net_cases=[]
unresolved_net_cases=[]
for p,seq in patient_sequences:
    first_last[f'{seq[0]["doctor"]}->{seq[-1]["doctor"]}'] += 1
    if any(seq[i-1]["doctor"] != seq[i]["doctor"] for i in range(1,len(seq))):
        key=f'{seq[0]["doctor"]}->{seq[-1]["doctor"]}'
        switch_first_last[key] += 1
        if seq[0]["doctor"] != seq[-1]["doctor"]:
            # Find start of final doctor run; >=2 visits in that run is evidence of continuation.
            j=len(seq)-1
            while j>0 and seq[j-1]["doctor"]==seq[-1]["doctor"]: j-=1
            run_len=len(seq)-j
            net_change_evidence[f'{key}|최종원장 2회이상'] += int(run_len>=2)
            net_change_evidence[f'{key}|최종원장 1회만(관찰제한)'] += int(run_len==1)
            final_case={"patient":mask_chart(p),"direction":key,"switchDate":seq[j]["date"],"switchGlobalOrdinal":seq[j]["globalOrdinal"],"finalRunVisits":run_len,"switchOnTuesday":date.fromisoformat(seq[j]["date"]).weekday()==1}
            (confirmed_net_cases if run_len>=2 else unresolved_net_cases).append(final_case)

global_ord_group=Counter()
for e in switch_events:
    n=e["destinationGlobalOrdinal"]
    global_ord_group[str(n) if n <= 5 else "6회차 이상"] += 1

result={
  "range":[START,END],
  "patientsInScope":len(patient_sequences),
  "visitsInScope":len(all_visits),
  "doctorVisitCounts":Counter(v["doctor"] for v in all_visits),
  "visitTypeCounts":type_raw,
  "uniqueSwitchPatients":len(switch_patients),
  "switchEvents":len(switch_events),
  "direction":direction,
  "monthly":monthly,
  "destinationOrdinalWithinPeriod":dest_ord,
  "destinationGlobalOrdinal":dest_global_ord,
  "destinationGlobalOrdinalGrouped":global_ord_group,
  "destinationVisitType":dest_type,
  "tuesdaySwitches":tuesday,
  "immediateReturnToOriginal":temporary,
  "continuedWithNewDoctorNextVisit":continued,
  "noNextVisitObserved":last_observed,
  "changesPerPatient":per_patient_change_count,
  "firstToLastDoctorWithinPeriod":first_last,
  "switchPatientsFirstToLastDoctor":switch_first_last,
  "netChangeEvidence":net_change_evidence,
  "confirmedNetChangeCasesMasked":confirmed_net_cases,
  "unresolvedNetChangeCasesMasked":unresolved_net_cases,
  "tuesdayKimToHeoInterpretation":{
    "events":len(tue_kh),
    "byDate":tue_kh_dates,
    "immediateNextVisitBackToKim":tue_kh_immediate,
    "eventuallyBackToKimWithinWindow":tue_kh_eventual,
    "laterVisitsRemainHeo":tue_kh_sustained,
    "noLaterVisitCensored":tue_kh_censored
  },
  "heoToKimEventsIdentifiedAsReturnAfterTuesdayCoverage":coverage_return_hk,
}

if len(sys.argv) > 1 and sys.argv[1] == "confirmed":
    print(json.dumps({"confirmed":confirmed_net_cases,"unresolved":unresolved_net_cases}, ensure_ascii=False, indent=2))
else:
    print(json.dumps(result, ensure_ascii=False, indent=2, default=dict))
