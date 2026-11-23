// Minimal RFC 4180 CSV reader/writer with a configurable delimiter (Cardmarket's files use ";", see
// markets/cardmarket/format.ts). Quoted fields may contain delimiters, quotes ("") and newlines.

/** The delimiter of a CSV text: the one among ; , \t that appears most in its first line (outside quotes). */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  let best = ";";
  let bestCount = -1;
  for (const d of [";", ",", "\t"]) {
    const count = unquoted.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Rows of a CSV text (the header included), skipping blank lines. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Records of a CSV text keyed by its header. */
export function parseCsvRecords(text: string, delimiter?: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text, delimiter);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])));
}

function quote(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A CSV text from a header and rows of values (CRLF line ends). */
export function writeCsv(header: string[], rows: Array<Array<string | number>>, delimiter = ";"): string {
  return [header, ...rows].map((r) => r.map((v) => quote(String(v), delimiter)).join(delimiter)).join("\r\n") + "\r\n";
}
