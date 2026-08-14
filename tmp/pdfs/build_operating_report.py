from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
from reportlab.graphics.shapes import Drawing, Rect, String, Line, PolyLine

ROOT = Path(r"C:\Users\Hippo\OneDrive\바탕 화면\inhouse")
OUT = ROOT / "output" / "pdf" / "경희홍익한의원_운영분석_2026-08-09.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

for name, file in [("Noto", "NotoSansKR-Regular.ttf"), ("NotoM", "NotoSansKR-Medium.ttf"), ("NotoB", "NotoSansKR-Bold.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(Path(r"C:\Windows\Fonts") / file)))

NAVY=colors.HexColor("#17324D"); TEAL=colors.HexColor("#148A8A"); MINT=colors.HexColor("#E8F5F3")
BLUE=colors.HexColor("#EAF1F8"); ORANGE=colors.HexColor("#E88C30"); RED=colors.HexColor("#C84C4C")
INK=colors.HexColor("#263746"); MUTED=colors.HexColor("#657786"); LINE=colors.HexColor("#D7E0E7"); PAPER=colors.HexColor("#F7F9FB")

ss=getSampleStyleSheet()
for n,kw in {
 "Cover":dict(fontName="NotoB",fontSize=25,leading=34,textColor=colors.white),
 "CoverSub":dict(fontName="Noto",fontSize=10,leading=17,textColor=colors.HexColor("#DDE9F2")),
 "H1":dict(fontName="NotoB",fontSize=17,leading=23,textColor=NAVY,spaceAfter=9),
 "H2":dict(fontName="NotoB",fontSize=12,leading=18,textColor=NAVY,spaceBefore=7,spaceAfter=5),
 "Body":dict(fontName="Noto",fontSize=8.7,leading=14,textColor=INK,spaceAfter=5),
 "Small":dict(fontName="Noto",fontSize=7.1,leading=10.5,textColor=MUTED),
 "Cell":dict(fontName="Noto",fontSize=7.2,leading=10,textColor=INK),
 "CellB":dict(fontName="NotoB",fontSize=7.2,leading=10,textColor=NAVY),
 "Callout":dict(fontName="NotoM",fontSize=9.6,leading=15.5,textColor=NAVY,backColor=MINT,borderColor=TEAL,borderWidth=.8,borderPadding=9,spaceAfter=8),
 "Note":dict(fontName="Noto",fontSize=7.6,leading=12,textColor=INK,backColor=PAPER,borderColor=LINE,borderWidth=.5,borderPadding=7,spaceAfter=6),
}.items(): ss.add(ParagraphStyle(name=n, **kw))
def P(x,s="Body"): return Paragraph(x,ss[s])
def footer(c,d):
    c.saveState(); w,h=A4; c.setStrokeColor(LINE); c.line(18*mm,14*mm,w-18*mm,14*mm)
    c.setFont("Noto",7); c.setFillColor(MUTED); c.drawString(18*mm,9*mm,"경희홍익한의원 운영 분석 | 내부 의사결정용")
    c.drawRightString(w-18*mm,9*mm,str(d.page)); c.restoreState()
def tbl(rows,widths,align=None):
    out=[]
    for r,row in enumerate(rows): out.append([P(str(v),"CellB" if r==0 else "Cell") for v in row])
    t=Table(out,colWidths=widths,repeatRows=1,hAlign="LEFT")
    st=[("GRID",(0,0),(-1,-1),.35,LINE),("BACKGROUND",(0,0),(-1,0),BLUE),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]
    for r in range(2,len(rows),2): st.append(("BACKGROUND",(0,r),(-1,r),colors.HexColor("#FAFBFC")))
    if align:
        for i,a in enumerate(align): st.append(("ALIGN",(i,1),(i,-1),a))
    t.setStyle(TableStyle(st)); return t
def cards(items):
    cells=[]
    for title,val,note,col in items:
        cells.append(Table([[P(title,"Small")],[Paragraph(val,ParagraphStyle(name=title,fontName="NotoB",fontSize=16,leading=20,textColor=col))],[P(note,"Small")]],colWidths=[37*mm],style=[("BOX",(0,0),(-1,-1),.6,LINE),("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]))
    return Table([cells],colWidths=[42*mm]*4,style=[("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),3)])
def bars(labels,values,maxv,title,cols=None):
    d=Drawing(170*mm,54*mm); d.add(String(0,144,title,fontName="NotoB",fontSize=9,fillColor=NAVY)); x0,y0,w,h=30,20,440,108
    d.add(Line(x0,y0,x0+w,y0,strokeColor=LINE)); bw=w/len(values)*.55
    for i,(lab,v) in enumerate(zip(labels,values)):
        x=x0+(i+.5)*w/len(values)-bw/2; bh=h*v/maxv; col=(cols[i] if cols else TEAL)
        d.add(Rect(x,y0,bw,bh,fillColor=col,strokeColor=None)); d.add(String(x+bw/2,y0-11,lab,fontName="Noto",fontSize=6.5,textAnchor="middle",fillColor=MUTED)); d.add(String(x+bw/2,y0+bh+3,str(v),fontName="NotoM",fontSize=6.5,textAnchor="middle",fillColor=INK))
    return d

S=[]
# 1 cover
cover=Table([[P("경희홍익한의원<br/>운영 분석 및 성장 제안","Cover")],[P("기준일 2026.08.09 · 부산 사하구 다대포<br/>최근 3년 DB 분석 · 허진혁 오너원장 중심","CoverSub")]],colWidths=[174*mm],rowHeights=[62*mm,30*mm],style=[("BACKGROUND",(0,0),(-1,-1),NAVY),("VALIGN",(0,0),(-1,-1),"BOTTOM"),("LEFTPADDING",(0,0),(-1,-1),14*mm),("BOTTOMPADDING",(0,0),(-1,-1),10*mm)])
S += [Spacer(1,18*mm),cover,Spacer(1,12*mm),P("한 장 결론","H2"),P("<b>재진이 무너진 병원이 아니라, 2024년 경쟁 공백으로 높아진 진료량이 정상화된 상태다.</b> 단기 진료량은 안정됐지만 전년 동기보다 낮고, 신규환자가 김상준 원장에게 상대적으로 많이 배분되어 허진혁 원장의 미래 환자 기반이 약해질 위험이 있다.","Callout")]
S += [P("우선 과제","H2"),tbl([["1","허진혁 원장에게 병원 브랜드 초진 65~70% 배분"],["2","허진혁 원장 2→3회차 전환율 개선"],["3","휴면환자 월 15~20명 복귀"],["4","추나·약침을 적응증과 기여이익 기준으로 표준화"],["5","김상준 원장 계약 종료에도 환자가 병원에 남는 인계 구조"]],[12*mm,156*mm],align=["CENTER","LEFT"]),Spacer(1,6*mm),P("분석 제한","H2"),P("치료·추나·약침·스파인은 2026년 7월 8일 이후, 간호사 정보와 진료시간은 7월 말 이후 기록되기 시작했다. 해당 항목은 최근 구간 내부 비교만 사용했다. DB에 실제 수납액과 원가가 없어 수익은 매출 기회 지표로 제시한다.","Note"),PageBreak()]

# 2 current
S += [P("1. 최근 운영 상황","H1"),cards([("일평균 진료","40.2명","직전 30일과 동일",NAVY),("초진 일평균","4.6명","직전 4.7명",TEAL),("진료 실환자","258명","전년 동기 -18.9%",ORANGE),("전체 진료","1,006건","전년 동기 -23.7%",RED)]),Spacer(1,6*mm)]
S += [tbl([["지표","최근 30일","직전 30일","전년 동기"],["진료일","25일","26일","26일"],["전체 진료","1,006","1,045","1,319"],["일평균 진료","40.2","40.2","50.7"],["초진 표시","116","121","139"],["초진 일평균","4.6","4.7","5.3"],["진료 실환자","258","263","318"]],[43*mm,38*mm,38*mm,49*mm],align=["LEFT","CENTER","CENTER","CENTER"]),Spacer(1,5*mm),P("최근 한 달은 직전 한 달 대비 급락하지 않았다. 다만 지난해 같은 기간보다 전체 진료와 실환자가 크게 낮아져, 낮아진 수준에서 안정된 것으로 해석해야 한다.","Callout")]
S += [P("3년 추세","H2"),bars(["2023","2024","2025","2026 YTD","최근30일"],[37.6,51.3,44.6,41.6,40.2],55,"일평균 진료 인원",[NAVY,ORANGE,TEAL,TEAL,TEAL]),P("2024년의 51.3명은 인접 한의원 폐업에 따른 반사수요가 포함된 고점이다. 현실적인 1차 목표는 일평균 43~45명, 초진 5.0~5.5명이다.","Note"),PageBreak()]

# 3 doctors
S += [P("2. 허진혁 원장 중심 분석","H1"),tbl([["최근 30일","허진혁","김상준","해석"],["진료 건수","715","291","전체의 71.1% / 28.9%"],["초진","66","50","전체 초진의 56.9% / 43.1%"],["일평균 진료","28.6","12.7","허 원장이 병원 총량의 기반"],["성숙 재진율","76.5%","87.5%","환자군·배정 차이 보정 필요"],["성숙 삼진율","52.9%","79.2%","허 원장 2→3회차 점검 필요"],["4회차 이상 진료","540","164","허 원장은 장기환자 비중이 높음"]],[37*mm,28*mm,28*mm,75*mm],align=["LEFT","CENTER","CENTER","LEFT"]),Spacer(1,5*mm)]
S += [P("핵심 위험","H2"),P("허진혁 원장은 전체 진료의 71%를 담당하지만 초진은 57%만 배정받는다. 이 구조가 지속되면 병원 브랜드로 유입된 신규환자의 상당 부분이 1년 단위 계약 원장의 환자군으로 축적된다. 김상준 원장이 떠날 경우 현재 진료량뿐 아니라 향후 재진을 만들 최근 코호트도 함께 약해질 수 있다.","Callout")]
S += [P("권장 초진 배분 원칙","H2"),tbl([["유입 경로","권장 배정"],["병원 검색·간판·소개·휴면환자 리콜","허진혁 65~70%"],["김상준 원장 지명·기존 환자 소개","김상준 유지"],["혼잡 시간·대기 초과","김상준 활용"],["특정 시술 적응증","환자 동의와 임상 기준"]],[75*mm,93*mm],align=["LEFT","LEFT"]),Spacer(1,4*mm),P("허진혁 원장 초진을 최근 월 66명에서 80~85명으로 높이는 것이 1차 목표다. 광고 확대 전 초진 재배분과 휴면환자 복귀로 먼저 채운다.","Note")]
S += [P("김상준 원장 계약 리스크","H2"),P("환자 기록·치료계획·다음 내원일을 병원 DB에 완전 저장하고, 계약 종료 3개월 전 잔류 여부 확정, 4~6주 인계기간, 공동진료 설명, 병원 유입 환자의 합법적 보호조항을 계약에 반영한다. 목표는 김 원장의 성과를 억제하는 것이 아니라 이탈 시에도 일평균 35명 아래로 급락하지 않는 구조다."),PageBreak()]

# 4 retention/revenue
S += [P("3. 재진과 수익 기회","H1"),cards([("전체 성숙 재진율","81.0%","2회차 도달",TEAL),("전체 성숙 삼진율","63.8%","3회차 도달",NAVY),("허진혁 삼진율","52.9%","목표 60% 이상",ORANGE),("휴면환자 풀","686명","과거 4회 이상",TEAL)]),Spacer(1,6*mm)]
S += [P("2회차에서 3회차로 이어지는 과정","H2"),P("진료 종료 전에 원장이 다음 치료 간격을 숫자로 명시하고, 수납 단계에서 다음 예약을 확정한다. 초진 후 7일 이내 미내원자와 2회차 후 10일 이상 미내원자를 자동 목록화해 결과를 예약·보류·호전·불만·타기관·연락불가로 기록한다.","Callout"),P("허진혁 원장 신규환자 80명 기준 삼진율을 53%에서 60%로 올리면 매월 약 5~6명이 추가로 3회차에 도달한다. 신규 광고로 같은 수의 초진을 확보하는 것보다 비용 효율이 높을 가능성이 크다.","Note")]
S += [P("추나·약침 기록: 최근 30일 내부 비교","H2"),tbl([["항목","허진혁","김상준","해석"],["진료기록","703","289","처방전용 제외"],["추나 기록","143 (약 20%)","134 (약 46%)","적응증·환자군·기록차 확인"],["약침 기록","440 (약 63%)","196 (약 68%)","원장 간 차이는 작음"]],[42*mm,34*mm,36*mm,56*mm],align=["LEFT","CENTER","CENTER","LEFT"]),Spacer(1,4*mm),P("추나의 원장 간 차이는 크지만 기록기간이 짧다. 판매 독려보다 ‘적응 환자→설명→동의→시행’ 퍼널을 기록해 임상 적정성과 전환을 분리해야 한다.","Note")]
S += [P("수익 관리식","H2"),P("<b>월 기여이익 = 시행 건수 × (실수납액 - 약제·소모품 원가 - 추가 인건비)</b><br/>추나·약침·패키지는 시행 건수만 보지 말고 실수납액, 원가, 사용 완료율, 중도이탈률과 연결한다.","Callout"),PageBreak()]

# 5 region
S += [P("4. 다대포 경쟁·지역 상황","H1"),P("경희홍익한의원은 다대로 698의 3층, 심평원 정보상 한의사 2명으로 신고돼 있다. 직접 생활권에는 다대로 680의 다대동한의원, 다대로 483의 춘해당한의원 등이 있어 ‘다대동 한의원’ 일반검색만으로는 차별화가 어렵다.","Callout")]
S += [tbl([["지역 신호","운영 의미","권장 대응"],["2024년 인접 경쟁 한의원 폐업","당시 고점은 반사수요 포함","2024년 51명/일을 정상 목표로 사용하지 않음"],["다대포 러너지원공간·생활체육","근골격계 생활수요 확대 가능","러닝 후 발목·무릎·허리 콘텐츠"],["낙조분수·야간경관 확대","주말 유동 증가, 주민 전환은 제한적","관광객보다 지역 주민 인지도에 활용"],["다대포 관광 방문 비중 7.5%","관광객은 주력 환자군이 아님","다대1·2동, 장림·신평 생활권 우선"],["외부 플랫폼 정보 불일치","층수·시간·의사 수 신뢰 저하","지도·주차·진료시간 일괄 정비"]],[38*mm,65*mm,65*mm],align=["LEFT","LEFT","LEFT"]),Spacer(1,5*mm)]
S += [P("초진 확보 채널 우선순위","H2"),tbl([["순위","채널","월 목표"],["1","90~180일 휴면환자 경과 확인","복귀 15~20명"],["2","허 원장 중심 2→3회차 이탈 방지","추가 5~6명"],["3","다대포역·다대동 지역 검색 정보 정비","초진 +5명"],["4","러닝·걷기·근골격계 지역 콘텐츠","3개월 누적 평가"],["5","장림·신평 근로자 및 토요일 수요","시간대 데이터 축적 후 확대"]],[18*mm,105*mm,45*mm],align=["CENTER","LEFT","CENTER"]),Spacer(1,5*mm),P("의료광고·개인정보 규정을 준수해야 한다. 휴면환자 연락은 판촉보다 치료 경과와 건강상태 확인 중심으로 운영하고, 지역 콘텐츠는 치료효과 보장이나 과장 표현을 피한다.","Note"),PageBreak()]

# 6 plan
S += [P("5. 90일 실행계획과 KPI","H1"),tbl([["기간","실행","책임 지표"],["1~2주","지도·층수·시간·주차 정보 통일<br/>초진 배정 원칙 확정<br/>허 원장 2→3회차 이탈 목록 생성<br/>휴면 90~180일군 추출","정보 정합성 100%<br/>대상군 확정"],["3~6주","주 40~50명 휴면 경과 확인<br/>초진 7일 미내원 자동 추적<br/>다대포 생활체육 콘텐츠 주 1회<br/>원장별 퍼널 주간 점검","허 원장 초진 월환산 80명<br/>휴면 복귀 월 15명"],["7~12주","복귀자의 재진 유지 평가<br/>시술별 실수납·원가 연결<br/>김 원장 재계약·인계조건 초안","일평균 43명<br/>허 원장 삼진율 60%"]],[28*mm,93*mm,47*mm],align=["CENTER","LEFT","LEFT"]),Spacer(1,7*mm)]
S += [P("핵심 KPI","H2"),tbl([["지표","현재","90일 목표","경고선"],["전체 일평균 진료","40.2명","43~45명","38명 미만"],["초진 일평균","4.6명","5.0~5.5명","4.3명 미만"],["허진혁 초진 비중","56.9%","65~70%","55% 미만"],["허진혁 성숙 삼진율","52.9%","60% 이상","50% 미만"],["휴면환자 복귀","미측정","월 15~20명","월 8명 미만"],["김상준 계약 리스크","연 1회 계약","3개월 전 확정","2개월 전 미확정"]],[50*mm,34*mm,42*mm,42*mm],align=["LEFT","CENTER","CENTER","CENTER"]),Spacer(1,5*mm),P("운영 원칙","H2"),P("<b>광고보다 먼저 기존 데이터의 누수를 막고, 김상준 원장의 성과를 활용하되 허진혁 오너원장의 환자 기반과 병원 자산으로 축적되게 한다.</b> 90일 뒤에는 환자 수뿐 아니라 원장별 초진 배정, 재진 퍼널, 휴면 복귀, 시술 기여이익을 함께 평가한다.","Callout"),PageBreak()]

# 7 methods
S += [P("부록. 기준·제한·참고자료","H1"),tbl([["구분","내용"],["분석 기준일","2026.08.09 (DB 마지막 진료일 2026.08.08)"],["최근 30일","2026.07.10~2026.08.08"],["직전 30일","2026.06.10~2026.07.09"],["전년 동기","2025.07.10~2025.08.08"],["3년 추이","2023.01.01~2026.08.08"],["치료 기록","2026.07.08 이후만 해석"],["간호사·시간 기록","2026년 7월 말 이후만 해석"],["매출 분석","실수납액·원가 부재로 기여이익 구조만 제시"]],[45*mm,123*mm],align=["LEFT","LEFT"]),Spacer(1,7*mm)]
S += [P("참고자료","H2"),P("• 건강보험심사평가원 병원정보: 경희홍익한의원·춘해당한의원<br/>• 부산광역시: 2026 다대포 러너지원공간, 생활체육 프로그램, 낙조분수 운영, 관광 시민인식조사<br/>• 사하구 2026 지역기본자료 및 다대포 개발·관광 관련 공개자료<br/>• 첨부 리포트: 경희홍익한의원 월간리포트 2026-08 (Claude 분석)<br/>• 내부 데이터: server/data/clinic.db 및 통계 API 집계","Body")]
S += [P("해석 주의","H2"),P("재진·삼진율은 최근 초진의 추적 완료 여부에 영향을 받으므로 성숙 코호트 지표를 우선했다. 원장별 시술률 차이는 환자군, 상병, 초진 배정, 기록 누락의 영향을 받을 수 있어 진료능력 차이로 단정하지 않았다. 지역 변화는 인과관계가 아니라 운영 가설이며, 향후 유입경로·예약·취소 데이터로 검증해야 한다.","Note"),Spacer(1,5*mm),HRFlowable(width="100%",color=LINE,thickness=.7),Spacer(1,4*mm),P("본 보고서는 내부 운영 의사결정을 위한 분석이며 의료·법률·세무 자문을 대체하지 않습니다.","Small")]

doc=SimpleDocTemplate(str(OUT),pagesize=A4,leftMargin=18*mm,rightMargin=18*mm,topMargin=18*mm,bottomMargin=20*mm,title="경희홍익한의원 운영 분석 및 성장 제안",author="Codex")
doc.build(S,onFirstPage=footer,onLaterPages=footer)
print(OUT)
