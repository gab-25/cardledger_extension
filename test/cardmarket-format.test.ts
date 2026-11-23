import { describe, expect, it } from "vitest";
import {
  URLS,
  buildImportCsv,
  conditionFromCm,
  formAction,
  formData,
  languageFromCm,
  looksLikeCsv,
  parseAlerts,
  parseCmDate,
  parseCmMoney,
  parseExportLink,
  parseOrderPage,
  parseSalesList,
  parseStockCsv,
  parseUsername,
} from "../src/markets/cardmarket/format";
import { change, fixture, html } from "./helpers";

describe("Cardmarket stock export", () => {
  it("parses the export CSV into stock rows", () => {
    const rows = parseStockCsv(fixture("cardmarket/stock-export.csv"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      market_listing_id: "1001234567", cm_product_id: 576041, name: "Ragavan, Nimble Pilferer", set_code: "MH2",
      collector_number: "138", condition: "NM", language: "EN", foil: false, quantity: 1, price: "48.00",
    });
    expect(rows[1]).toMatchObject({ name: "Sheoldred, the Apocalypse", condition: "LP", language: "IT", quantity: 2, price: "71.80" });
    expect(rows[2]).toMatchObject({ condition: "M", language: "JP", foil: true, price: "19.20" });
    expect(rows[3]).toMatchObject({ collector_number: "45", condition: "EX" });
  });

  it("accepts other column names and a comma delimiter", () => {
    const rows = parseStockCsv("Article ID,Product ID,Name,Set,Price,Language,Condition,Foil,Quantity\n9,10,Bolt,LEA,\"1,50\",German,Near Mint,,3\n,11,skipped\n");
    expect(rows).toEqual([{ market_listing_id: "9", cm_product_id: 10, name: "Bolt", set_code: "LEA", collector_number: "",
      condition: "NM", language: "DE", foil: false, quantity: 3, price: "1.50" }]);
  });

  it("tells a CSV download from an HTML page", () => {
    expect(looksLikeCsv(fixture("cardmarket/stock-export.csv"))).toBe(true);
    expect(looksLikeCsv(fixture("cardmarket/export-page.html"))).toBe(false);
    expect(looksLikeCsv("whatever", "text/csv; charset=utf-8")).toBe(true);
  });
});

describe("Cardmarket stock import", () => {
  it("generates the import CSV from plan changes", () => {
    const csv = buildImportCsv([
      change({ action: "create", quantity: 2, price: "45.5" }),
      change({ action: "update", market_listing_id: "1001234568", quantity: 1, price: 69, comment: "Light wear; see photos",
        item: { cm_product_id: 662321, condition: "LP", language: "IT" } }),
      change({ action: "delete", market_listing_id: "1001234570", price: "0.80", item: { cm_product_id: 694580, condition: "EX", language: "IT" } }),
      change({ action: "create", price: 20, comment: 'says "foil"', item: { cm_product_id: 636203, condition: "M", language: "JP", foil: true } }),
    ]);
    expect(csv.replace(/\r\n/g, "\n")).toBe(fixture("cardmarket/import-expected.csv"));
  });

  it("round-trips codes", () => {
    expect(conditionFromCm("MT")).toBe("M");
    expect(conditionFromCm("light played")).toBe("LP");
    expect(languageFromCm("6")).toBe("ZHS");
    expect(languageFromCm("Italian")).toBe("IT");
  });
});

describe("Cardmarket pages", () => {
  it("reads the logged-in username, or none", () => {
    expect(parseUsername(html(fixture("cardmarket/export-page.html")))).toBe("LedgerShop");
    expect(parseUsername(html(fixture("cardmarket/logged-out.html")))).toBeNull();
  });

  it("reads alerts and the export download link", () => {
    expect(parseAlerts(html(fixture("cardmarket/import-refused.html")))).toEqual({
      success: null, error: 'The file could not be read: unknown column "Foil?".',
    });
    expect(parseExportLink(html(fixture("cardmarket/export-ready.html")))).toBe("https://www.cardmarket.com/en/Magic/Stock/Export/File/88123");
    expect(parseExportLink(html(fixture("cardmarket/export-page.html")))).toBeNull();
  });

  it("collects the form's fields with the file", async () => {
    const doc = html(fixture("cardmarket/import-page.html"));
    const form = doc.querySelector("form")!;
    const data = formData(form, { csvFile: new Blob(["a;b"], { type: "text/csv" }) });
    expect(data.get("__cmtkn")).toBe("tok-import-7");
    expect(data.getAll("mode")).toEqual(["replace"]);
    expect((data.get("csvFile") as File).name).toBe("stock.csv");
    expect(formAction(form, URLS.stockImport("mtg"))).toBe("https://www.cardmarket.com/en/Magic/PostGetAction/Stock_Import");
  });

  it("lists order ids of a sales page", () => {
    expect(parseSalesList(html(fixture("cardmarket/sales-paid.html")))).toEqual(["1172001", "1172002"]);
  });

  it("parses a paid order", () => {
    const order = parseOrderPage(html(fixture("cardmarket/order-paid.html")), "1172001", "paid");
    expect(order).toEqual({
      market_order_id: "1172001", state: "paid", buyer_username: "buyer_anna", buyer_name: "Anna Bianchi",
      ship_name: "Anna Bianchi", ship_street: "Via Po 12, c/o Studio Rossi", ship_zip: "10123", ship_city: "Torino",
      ship_province: "", ship_country: "Italy", ship_country_code: "", ship_note: "",
      shipping_method: "Registered Letter (Italy)", tracked: true, tracking_code: "",
      paid_at: "2026-11-21T14:03:00+01:00", sent_at: null,
      items_total: "48.00", shipping_cost: "3.30", market_fee: "2.40", total: "51.30", net: "48.90", currency: "EUR",
      items: [
        { market_item_id: "1172001-1001234567", market_listing_id: "1001234567", name: "Ragavan, Nimble Pilferer",
          expansion: "Modern Horizons 2", condition: "NM", language: "EN", foil: false, quantity: 1, price: "40.00" },
        { market_item_id: "1172001-1001234570", market_listing_id: "1001234570", name: "Counterspell",
          expansion: "Dominaria Remastered", condition: "EX", language: "IT", foil: true, quantity: 2, price: "4.00" },
      ],
    });
  });

  it("parses a sent order (summer time, thousands separator, untracked)", () => {
    const order = parseOrderPage(html(fixture("cardmarket/order-sent.html")), "1172002", "sent");
    expect(order).toMatchObject({
      buyer_username: "mtg_marco", ship_zip: "10115", ship_city: "Berlin", ship_country: "Germany", tracked: false,
      paid_at: "2026-07-02T09:10:00+02:00", sent_at: "2026-07-03T18:45:00+02:00",
      items_total: "1234.50", total: "1235.65", market_fee: null, net: "1235.65",
    });
    expect(order.items[0]).toMatchObject({ name: "Black Lotus", language: "EN", condition: "PL", price: "1234.50" });
  });

  it("parses money and dates", () => {
    expect(parseCmMoney("12,34 €")).toBe("12.34");
    expect(parseCmMoney("€ 1,234.5")).toBe("1234.50");
    expect(parseCmMoney("1.234 €")).toBe("1234.00");
    expect(parseCmMoney("—")).toBeNull();
    expect(parseCmDate("05.01.2026")).toBe("2026-01-05T00:00:00+01:00");
    expect(parseCmDate("no date")).toBeNull();
  });
});
