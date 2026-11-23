import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseCsvRecords, writeCsv } from "../src/lib/csv";

describe("csv", () => {
  it("parses quoted fields with delimiters, quotes and newlines", () => {
    const text = '﻿a;b;c\r\n1;"x;y";"say ""hi"""\n2;"multi\nline";\n\n';
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["1", "x;y", 'say "hi"'], ["2", "multi\nline", ""]]);
  });

  it("detects the delimiter from the header", () => {
    expect(detectDelimiter("a,b,c\n1;2,3")).toBe(",");
    expect(detectDelimiter('"x,y";b;c')).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("keys records by header", () => {
    expect(parseCsvRecords("Name,Amount\nBolt,4\nShort\n")).toEqual([{ Name: "Bolt", Amount: "4" }, { Name: "Short", Amount: "" }]);
  });

  it("writes and reads back", () => {
    const out = writeCsv(["a", "b"], [["x;y", 'q"'], [1, ""]]);
    expect(out).toBe('a;b\r\n"x;y";"q"""\r\n1;\r\n');
    expect(parseCsv(out)).toEqual([["a", "b"], ["x;y", 'q"'], ["1", ""]]);
  });
});
