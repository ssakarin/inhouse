import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const file = "C:/Users/Hippo/OneDrive/바탕 화면/자료/2026년_1월1일-8월10일_진료비_비교_월별가로요약.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
const overview = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 16000,
  tableMaxRows: 15,
  tableMaxCols: 20,
  tableMaxCellChars: 120,
});
console.log(overview.ndjson);
