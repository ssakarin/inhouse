import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/Hippo/OneDrive/바탕 화면/연락처/2013~202606_dong/2026년.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 4000 });
console.log("SHEETS");
console.log(sheets.ndjson);
const summary = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 8000,
  tableMaxRows: 8,
  tableMaxCols: 20,
  tableMaxCellChars: 80,
});
console.log("SUMMARY");
console.log(summary.ndjson);
const firstSheet = workbook.worksheets.getItemAt(0);
const used = firstSheet.getUsedRange(true);
const timeColumns = firstSheet.getRange("B1:Z5736").values;
const headers = timeColumns[0] || [];
for (const headerName of ["접수시각", "진료시각"]) {
  const index = headers.indexOf(headerName);
  if (index < 0) continue;
  const values = timeColumns.slice(1).map(row => row[index]).filter(value => value !== null && value !== undefined && value !== "");
  console.log("TIME_COLUMN", JSON.stringify({
    header: headerName,
    nonEmpty: values.length,
    numeric: values.filter(value => typeof value === "number").length,
    samples: values.slice(0, 8),
  }));
}
const rowCount = Math.min(15, used.rowCount || 15);
const colCount = Math.min(30, used.columnCount || 30);
const sample = await workbook.inspect({
  kind: "table",
  sheetId: firstSheet.name,
  range: firstSheet.getRangeByIndexes(0, 0, rowCount, colCount).address,
  include: "values,formulas",
  tableMaxRows: rowCount,
  tableMaxCols: colCount,
  tableMaxCellChars: 80,
  maxChars: 12000,
});
console.log("SAMPLE");
console.log(sample.ndjson);
const preview = await workbook.render({ sheetName: firstSheet.name, range: firstSheet.getRangeByIndexes(0, 0, Math.min(20, used.rowCount || 20), Math.min(16, used.columnCount || 16)).address, scale: 1 });
await fs.writeFile("preview.png", new Uint8Array(await preview.arrayBuffer()));
