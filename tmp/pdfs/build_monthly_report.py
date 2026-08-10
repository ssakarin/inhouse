from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    KeepTogether, HRFlowable
)
from reportlab.graphics.shapes import Drawing, Rect, String, Line
from pathlib import Path

ROOT = Path(r"C:\Users\Hippo\OneDrive\바탕 화면\inhouse")
OUT = ROOT / "output" / "pdf" / "다대포_한의원_월간요약_2026-07-10_2026-08-08.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

pdfmetrics.registerFont(TTFont("Noto", r"C:\Windows\Fonts\NotoSansKR-Regular.ttf"))
pdfmetrics.registerFont(TTFont("NotoM", r"C:\Windows\Fonts\NotoSansKR-Medium.ttf"))
pdfmetrics.registerFont(TTFont("NotoB", r"C:\Windows\Fonts\NotoSansKR-Bold.ttf"))

NAVY = colors.HexColor("#17324D")
TEAL = colors.HexColor("#148A8A")
MINT = colors.HexColor("#E8F5F3")
BLUE_BG = colors.HexColor("#EAF1F8")
ORANGE = colors.HexColor("#E88C30")
RED = colors.HexColor("#C84C4C")
INK = colors.HexColor("#263746")
MUTED = colors.HexColor("#657786")
LINE = colors.HexColor("#D7E0E7")
PAPER = colors.HexColor("#F7F9FB")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CoverTitle", fontName="NotoB", fontSize=25, leading=34, textColor=colors.white))
styles.add(ParagraphStyle(name="CoverSub", fontName="Noto", fontSize=10.5, leading=17, textColor=colors.HexColor("#DDE9F2")))
styles.add(ParagraphStyle(name="H1K", fontName="NotoB", fontSize=17, leading=23, textColor=NAVY, spaceBefore=2, spaceAfter=9))
styles.add(ParagraphStyle(name="H2K", fontName="NotoB", fontSize=12.5, leading=18, textColor=NAVY, spaceBefore=8, spaceAfter=6))
styles.add(ParagraphStyle(name="BodyK", fontName="Noto", fontSize=8.8, leading=14.2, textColor=INK, spaceAfter=5))
styles.add(ParagraphStyle(name="SmallK", fontName="Noto", fontSize=7.2, leading=11, textColor=MUTED))
styles.add(ParagraphStyle(name="NoteK", fontName="Noto", fontSize=7.7, leading=12, textColor=INK, backColor=PAPER, borderColor=LINE, borderWidth=.6, borderPadding=7, spaceBefore=4, spaceAfter=7))
styles.add(ParagraphStyle(name="CalloutK", fontName="NotoM", fontSize=10, leading=16, textColor=NAVY, backColor=MINT, borderColor=TEAL, borderWidth=.8, borderPadding=9, spaceAfter=9))
styles.add(ParagraphStyle(name="CellK", fontName="Noto", fontSize=7.4, leading=10.4, textColor=INK))
styles.add(ParagraphStyle(name="CellBK", fontName="NotoB", fontSize=7.4, leading=10.4, textColor=NAVY))
styles.add(ParagraphStyle(name="CenterK", fontName="Noto", fontSize=7.4, leading=10.4, textColor=INK, alignment=TA_CENTER))

def P(text, style="BodyK"):
    return Paragraph(text, styles[style])

def footer(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setStrokeColor(LINE)
    canvas.line(18*mm, 14*mm, w-18*mm, 14*mm)
    canvas.setFont("Noto", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18*mm, 9*mm, "다대포 한의원 월간 운영 요약 | 내부 검토용")
    canvas.drawRightString(w-18*mm, 9*mm, str(doc.page))
    canvas.restoreState()

def table(data, widths, header=True, aligns=None):
    converted = []
    for r, row in enumerate(data):
        converted.append([P(str(v), "CellBK" if r == 0 and header else ("CenterK" if aligns and aligns[c] == "C" else "CellK")) for c, v in enumerate(row)])
    t = Table(converted, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    ts = [
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("GRID", (0,0), (-1,-1), .35, LINE),
        ("LEFTPADDING", (0,0), (-1,-1), 5), ("RIGHTPADDING", (0,0), (-1,-1), 5),
        ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("BACKGROUND", (0,0), (-1,0), BLUE_BG),
    ]
    for r in range(1, len(data)):
        if r % 2 == 0: ts.append(("BACKGROUND", (0,r), (-1,r), colors.HexColor("#FAFBFC")))
    if aligns:
        for c,a in enumerate(aligns): ts.append(("ALIGN", (c,1 if header else 0), (c,-1), "CENTER" if a == "C" else "LEFT"))
    t.setStyle(TableStyle(ts))
    return t

def metric_cards(cards):
    cells=[]
    for title, value, note, color in cards:
        cells.append(Table([[P(title,"SmallK")],[Paragraph(value, ParagraphStyle(name="mv"+title, fontName="NotoB", fontSize=16, leading=20, textColor=color))],[P(note,"SmallK")]], colWidths=[39*mm], style=[("BACKGROUND",(0,0),(-1,-1),colors.white),("BOX",(0,0),(-1,-1),.6,LINE),("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]))
    return Table([cells], colWidths=[42*mm]*len(cells), hAlign="LEFT", style=[("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),3)])

def bar_chart(labels, values, maxv, title):
    d=Drawing(170*mm, 58*mm)
    d.add(String(0, 155, title, fontName="NotoB", fontSize=9, fillColor=NAVY))
    x0,y0,w,h=28,18,440,120
    d.add(Line(x0,y0,x0,y0+h,strokeColor=LINE)); d.add(Line(x0,y0,x0+w,y0,strokeColor=LINE))
    bw=w/len(values)*.58
    for i,(lab,val) in enumerate(zip(labels,values)):
        x=x0+(i+.5)*w/len(values)-bw/2
        bh=h*val/maxv
        d.add(Rect(x,y0,bw,bh,fillColor=TEAL if i not in (0,) else ORANGE,strokeColor=None))
        d.add(String(x+bw/2,y0-11,lab,fontName="Noto",fontSize=6.5,textAnchor="middle",fillColor=MUTED))
        d.add(String(x+bw/2,y0+bh+4,str(val),fontName="NotoM",fontSize=6.5,textAnchor="middle",fillColor=INK))
    return d

story=[]

# Cover
cover = Table([[P("다대포 한의원<br/>월간 운영 요약", "CoverTitle")], [P("2026.07.10 - 2026.08.08<br/>비교기간 2026.06.10 - 2026.07.09", "CoverSub")]], colWidths=[174*mm], rowHeights=[65*mm, 28*mm], style=[("BACKGROUND",(0,0),(-1,-1),NAVY),("VALIGN",(0,0),(-1,-1),"BOTTOM"),("LEFTPADDING",(0,0),(-1,-1),14*mm),("RIGHTPADDING",(0,0),(-1,-1),14*mm),("TOPPADDING",(0,0),(-1,-1),10*mm),("BOTTOMPADDING",(0,0),(-1,-1),10*mm)])
story += [Spacer(1,18*mm), cover, Spacer(1,13*mm)]
story += [P("이번 달 판단", "H2K"), P("<b>진료일이 하루 줄었지만 일평균 진료량은 유지됐고, 전체 재진 성과는 개선됐다.</b> 신규 유입은 소폭 둔화됐으나 기존 환자 기반이 진료량을 방어했다. 원장별로는 김상준 원장의 성장과 재방문 개선이 두드러졌고, 허진혁 원장은 2회차 이후 이탈 점검이 우선 과제다.", "CalloutK")]
story += [P("분석 전제", "H2K"), P("치료 데이터는 7월 8일부터 집계되어 이번 기간의 절대 수준은 활용 가능하지만 직전 기간과의 증감 비교는 유효하지 않다. 시간대 및 간호사 배정 관련 집계는 7월 28일부터 시작됐다. 원문에는 간호사별 배정표가 없어 직원별 업무량 분석은 제외했다.", "NoteK")]
story += [Spacer(1,5*mm), P("진료지역", "SmallK"), Paragraph("부산광역시 사하구 다대포", ParagraphStyle(name="loc",fontName="NotoB",fontSize=13,leading=18,textColor=TEAL))]
story += [PageBreak()]

# Page 2
story += [P("1. 핵심 경영 지표", "H1K")]
story += [metric_cards([
    ("진료 건수", "1,006건", "직전 대비 -3.7%", NAVY),
    ("일평균 진료", "40.2건", "직전과 동일", TEAL),
    ("재진율", "75.0%", "+8.9%p", TEAL),
    ("삼진율", "55.6%", "+5.2%p", TEAL),
]), Spacer(1,7*mm)]
story += [table([
    ["지표","이번 기간","직전 기간","변화","판단"],
    ["진료일","25일","26일","-1일","총량 감소의 주된 배경"],
    ["진료 건수","1,006","1,045","-3.7%","일평균은 동일"],
    ["환자 수","271","272","-0.4%","사실상 유지"],
    ["약환 제외 환자","258","263","-1.9%","소폭 감소"],
    ["초진","116","121","-4.1%","신규 유입 둔화"],
    ["재진 환자","142","142","동일","기존 기반 안정"],
    ["21일 재진율","75.0%","66.1%","+8.9%p","개선"],
    ["21일 삼진율","55.6%","50.4%","+5.2%p","개선"],
], [29*mm,25*mm,25*mm,23*mm,66*mm], aligns=["L","C","C","C","L"]), Spacer(1,6*mm)]
story += [P("구조적 해석", "H2K"), P("총진료 중 4회차 이상 진료가 704건으로 약 70%를 차지한다. 외형상 총진료가 감소했지만 진료일 보정 후 생산성은 유지됐으며, 장기 기존 환자가 안정판 역할을 했다. 반면 일평균 환자는 직전 3개월 평균 41.5명보다 약 4%, 전년 동기 50.5명보다 약 21% 낮다. 전년 비교에는 김상준 원장의 4월 합류와 원장 간 환자 배분 변화가 포함되므로 수요 감소로 단정해서는 안 된다.")]
story += [P("주의", "H2K"), P("기간 종료가 8월 8일이므로 21일 재진·삼진 지표가 최근 초진까지 포함한다면 추적이 완료되지 않았을 수 있다. 지표 산식에서 미성숙 코호트를 제외했는지 확인이 필요하다.", "NoteK")]
story += [PageBreak()]

# Page 3 doctors
story += [P("2. 원장별 성과", "H1K")]
story += [P("허진혁 원장", "H2K"), table([
    ["지표","이번","직전","변화"],
    ["진료 건수","715","769","-7.0%"],
    ["일평균 진료 건수","28.6","29.6","-3.3%"],
    ["환자 수","203","218","-6.9%"],
    ["초진 / 재진 환자","66 / 126","72 / 138","각 -8.3% / -8.7%"],
    ["재진율 / 삼진율","64.7% / 29.4%","65.3% / 48.6%","-0.6%p / -19.2%p"],
], [46*mm,35*mm,35*mm,52*mm], aligns=["L","C","C","C"]), Spacer(1,4*mm), P("기존 장기 환자 기반은 견고하지만 삼진율 하락이 핵심 위험 신호다. 첫 재방문보다 2회차 이후 다음 예약 확정, 치료 간격 안내, 7일 이상 미예약 환자 추적을 우선 점검한다.", "NoteK")]
story += [P("김상준 원장", "H2K"), table([
    ["지표","이번","직전","변화"],
    ["진료 건수","291","276","+5.4%"],
    ["일평균 진료 건수","12.6","12.5","+0.8%"],
    ["환자 수","88","78","+12.8%"],
    ["초진 / 재진 환자","50 / 36","49 / 28","+2.0% / +28.6%"],
    ["재진율 / 삼진율","84.2% / 78.9%","67.3% / 53.1%","+16.9%p / +25.8%p"],
], [46*mm,35*mm,35*mm,52*mm], aligns=["L","C","C","C"]), Spacer(1,4*mm), P("4월 진료 시작 이후 환자 기반이 성장하고 있다. 이번 달은 초진 증가보다 과거 초진의 재방문 전환이 성장을 만들었다. 표본이 상대적으로 작아 비율 변동성이 크므로 8~9월까지 절대 인원과 함께 추적하면서 신규 배정을 점진적으로 확대한다.", "NoteK")]
story += [P("원장별 운영 판단", "H2K"), P("전체 진료 건수 비중은 허진혁 71.1%, 김상준 28.9%다. 원장별 재방문 차이는 진료 품질뿐 아니라 환자군, 상병, 신규 배정과 진료일 차이의 영향을 받을 수 있으므로 동일 조건으로 보정한 후 평가해야 한다.")]
story += [PageBreak()]

# Page 4 treatment and time
story += [P("3. 치료 구성과 시간대", "H1K")]
story += [P("치료 구성", "H2K"), P("이번 기간은 치료 집계 시작일 이후이므로 절대 수준은 활용 가능하다. 직전 기간은 7월 8~9일 정도만 반영되어 증감률 비교에서 제외한다.", "NoteK")]
story += [table([
    ["구분","전체","허진혁","김상준"],
    ["약침 시행 환자","186명 (72.1%)","137명 (71.4%)","65명 (75.6%)"],
    ["추나 시행 환자","77명 (29.8%)","43명 (22.4%)","38명 (44.2%)"],
    ["단순 / 복합추나","40 / 37명","18 / 25명","24 / 14명"],
    ["약침 패키지 결제","19명","자료상 원장별 중복 표기","자료상 원장별 중복 표기"],
], [38*mm,42*mm,44*mm,44*mm], aligns=["L","C","C","C"]), Spacer(1,4*mm)]
story += [P("김상준 원장의 추나 시행률은 허진혁 원장의 약 2배다. 환자군 차이 또는 진료 스타일 차이일 수 있으므로 상병과 초·재진 구성을 보정해 해석한다. 침·핫팩은 원문에 별도 수치가 없어 이번 보고서에서 정량 분석하지 않았다.", "BodyK")]
story += [P("평일 시간대 환자 수 - 7월 28일 이후 부분 표본", "H2K"), bar_chart(["09","10","11","12","13","14","15","16","17"],[93,50,43,7,34,50,34,50,32],100,"환자 수")]
story += [P("평일 09시는 93명으로 전체 표본의 23.7%이며, 14시와 16시가 각 50명으로 두 번째 피크다. 토요일은 54명 중 09시가 25명(46.3%)으로 집중도가 더 높다.", "BodyK")]
story += [P("배치 제안", "H2K"), table([
    ["구간","운영 제안"],
    ["평일 08:50~11:00","접수·치료실 인력 집중, 초진 도착시간 분산"],
    ["평일 13:50~16:30","오후 두 번째 피크 대응"],
    ["토요일 08:50~10:30","최대 간호 인력 배치"],
    ["평일 12시 / 토요일 13시","휴게·소독·재고점검 후보"],
], [50*mm,118*mm], aligns=["L","L"])]
story += [PageBreak()]

# Page 5 local factors/action
story += [P("4. 다대포 계절·기상 보정", "H1K")]
story += [P("분석 기간 초반 부산 서부에는 폭염주의보가 내려졌고, 7월 21일에는 부산 동부를 제외한 지역에 폭염경보가 발효됐다. 7월 26일 부산 금정구에서는 체감온도 36.8℃가 관측되는 등 부산권 전반이 강한 고온의 영향을 받았다. 다대포는 해안의 바람으로 낮 최고기온이 일부 완화될 수 있지만 높은 습도와 열대야로 체감 부담이 지속될 수 있다.", "CalloutK")]
story += [table([
    ["지역 요인","환자 행동에 가능한 영향","운영상 해석"],
    ["폭염·높은 습도","고령층과 보행 불편 환자의 오후 외출 감소","오전 예약 선호와 09시 집중 강화 가능"],
    ["열대야·냉방","수면 저하, 피로, 목·어깨·허리 불편 증가 가능","근골격계 관련 상담 수요 가능성"],
    ["여름휴가·방학","정기 예약 변경, 치료 간격 증가","초진 둔화와 일부 재진 지연 가능"],
    ["해수욕장 성수기","유동인구 증가와 교통·주차 혼잡 동시 발생","관광객 증가가 초진으로 바로 전환되지는 않음"],
    ["국지성 강수","당일 취소와 지각 가능","날씨별 예약·취소 데이터 필요"],
], [35*mm,67*mm,66*mm], aligns=["L","L","L"]), Spacer(1,5*mm)]
story += [P("계절 요인은 인과관계가 아니라 해석 변수다", "H2K"), P("같은 폭염 환경에서도 김상준 원장의 재방문 지표는 상승했으므로 허진혁 원장의 삼진율 하락을 날씨만으로 설명할 수 없다. 날짜별 체감온도·강수 여부와 예약·취소·초진·진료 건수를 연결해야 실제 영향을 검증할 수 있다.", "NoteK")]
story += [P("5. 다음 달 우선 실행안", "H1K")]
story += [table([
    ["우선순위","실행안","확인 지표"],
    ["1","허진혁 원장 2회차 종료 전 다음 예약 확정, 7일 이상 미예약 추적","삼진율, 2→3회차 전환율"],
    ["2","폭염일 고령 환자를 오전 또는 늦은 오후로 안내","시간대별 예약·취소율"],
    ["3","토요일 09~10시 접수·치료실 집중 배치","대기시간, 침상 회전"],
    ["4","김상준 원장 신규 배정 점진 확대, 8~9월 유지 여부 확인","초진 수, 재진 절대 인원"],
    ["5","기상·교통·주차 정보와 일별 운영 데이터를 연결","날씨별 취소·노쇼율"],
    ["6","8월부터 치료 항목의 완전한 월간 비교 시작","시행률, 환자당 횟수"],
], [18*mm,102*mm,48*mm], aligns=["C","L","L"])]
story += [PageBreak()]

# Sources/method
story += [P("부록. 데이터 기준과 출처", "H1K")]
story += [P("데이터 기준", "H2K"), table([
    ["항목","기준"],
    ["현재 기간","2026.07.10~2026.08.08, 진료일 25일"],
    ["직전 기간","2026.06.10~2026.07.09, 같은 길이, 진료일 26일"],
    ["직전 3개월","2026.04.11~2026.07.09"],
    ["전년 동기","2025.07.10~2025.08.08"],
    ["치료 집계","2026.07.08경 시작. 현재 절대 수준만 해석"],
    ["시간대·배정 집계","2026.07.28 시작. 부분 표본"],
    ["김상준 원장","2026년 4월 진료 시작"],
], [48*mm,120*mm], aligns=["L","L"]), Spacer(1,7*mm)]
story += [P("외부 참고자료", "H2K")]
sources = [
    ("기상청 다대포해수욕장 예보", "https://www.weather.go.kr/special/CRP/beach/rpt_beach_308.html"),
    ("기상청 2026년 7월 9일 특보 현황 - 부산서부 폭염주의보", "https://www.weather.go.kr/w/weather/warning/status.do?cpath=%2Fbangjae"),
    ("기상청 2026년 7월 21일 특보 - 부산 폭염경보", "https://www.weather.go.kr/w/special/summer/sea.do"),
    ("기상청 2026년 7월 26일 폭염 현황", "https://www.weather.go.kr/w/special-report/list.do"),
]
for title,url in sources:
    story.append(P(f"<b>{title}</b><br/><font color='#657786'>{url}</font>", "SmallK")); story.append(Spacer(1,2*mm))
story += [Spacer(1,5*mm), HRFlowable(width="100%", color=LINE, thickness=.7), Spacer(1,4*mm), P("이 보고서는 제공된 비식별 월간 집계자료를 기반으로 작성한 운영 분석이다. 계절·기상 요인은 관측·특보와 지역 특성을 활용한 설명 변수이며, 날짜별 환자 데이터와 연결되지 않은 상태에서는 인과관계로 해석하지 않는다.", "SmallK")]

doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=18*mm, bottomMargin=20*mm, title="다대포 한의원 월간 운영 요약", author="Codex")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
