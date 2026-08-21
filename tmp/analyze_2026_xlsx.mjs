import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/Hippo/OneDrive/바탕 화면/연락처/2013~202606_dong/2026년.xlsx";
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange();
  if (!used) continue;
  const values = used.values;
  const headers = values[0].map((value, index) => String(value || `열${index + 1}`).trim());
  const rows = values.slice(1);
  const sensitive = /수진자명|성\s*명|주민|휴대|보험증|승인번호|참조|오류|주의/;
  const columns = headers.map((header, index) => {
    const present = rows.map(row => row[index]).filter(value => value !== null && value !== undefined && value !== "");
    const counts = new Map();
    if (!sensitive.test(header)) {
      for (const value of present) {
        const key = String(value).trim();
        counts.set(key, (counts.get(key) || 0) + 1);
        if (counts.size > 500) break;
      }
    }
    const top = counts.size <= 500
      ? [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      : [];
    return {
      index: index + 1,
      header,
      nonEmpty: present.length,
      fillRate: Number((present.length / rows.length).toFixed(3)),
      numeric: present.filter(value => typeof value === "number").length,
      distinctObserved: sensitive.test(header) ? "redacted" : counts.size,
      top: sensitive.test(header) ? [] : top,
    };
  });
  console.log(JSON.stringify({
    type: "profile",
    sheet: sheet.name,
    address: used.address,
    dataRows: rows.length,
    columnCount: used.columnCount,
    columns,
  }));
}
