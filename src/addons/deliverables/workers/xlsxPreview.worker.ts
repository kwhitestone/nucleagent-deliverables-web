import { read, utils } from "xlsx";

interface PreviewResult {
  rows?: string[][];
  errorKey?: "workbookParseFailed";
}

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const workbook = read(event.data, { type: "array", dense: true, sheetRows: 201 });
    const first = workbook.SheetNames[0];
    const values = first
      ? utils.sheet_to_json<unknown[]>(workbook.Sheets[first], { header: 1, raw: false, blankrows: false, defval: "" })
      : [];
    const rows = values.slice(0, 200).map((row) => row.slice(0, 30).map((cell) => String(cell ?? "")));
    self.postMessage({ rows } satisfies PreviewResult);
  } catch {
    self.postMessage({ errorKey: "workbookParseFailed" } satisfies PreviewResult);
  }
};
