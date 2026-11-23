import { describe, expect, it } from "vitest";
import {
  URLS,
  buildImportCsv,
  conditionFromCt,
  isSignInPage,
  isSignInUrl,
  languageFromCt,
  looksLikeCsv,
  parseAlerts,
  parseCsrfToken,
  parseCtMoney,
  parseExportLink,
  parseInventoryCsv,
  parseOrderPage,
  parseOrdersList,
  parseUsername,
  toStockRow,
} from "../src/markets/cardtrader/format";
import { change, fixture, html } from "./helpers";

const page = (name: string) => html(fixture(`cardtrader/${name}`));

describe("CardTrader inventory export", () => {
  it("parses the export CSV into stock rows with blueprint, Cardmarket id and tag", () => {
    const rows = parseInventoryCsv(fixture("cardtrader/inventory-export.csv"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      market_listing_id: "5001", ct_blueprint_id: 9001, cm_product_id: 576041, name: "Ragavan, Nimble Pilferer",
      set_code: "MH2", collector_number: "138", condition: "NM", language: "EN", foil: false, quantity: 1, price: "48.00",
      tag: "cardledger:11",
    });
    expect(rows[1]).toMatchObject({ ct_blueprint_id: 9100, cm_product_id: null, condition: "LP", language: "IT", quantity: 2, price: "71.80", tag: "" });
    expect(rows[2]).toMatchObject({ collector_number: "25", condition: "M", language: "JP", foil: true });
    expect(rows[3]).toMatchObject({ name: "Modern Horizons 2 Booster Box", condition: "", collector_number: "", quantity: 3 });
    expect(toStockRow(rows[0]!)).not.toHaveProperty("tag");
  });

  it("accepts other column names, a ; delimiter and prices in cents", () => {
    expect(parseInventoryCsv("product_id;Blueprint ID;Name;price_cents;Quantity;Language\n7;8;Bolt;150;3;Italian\n;9;skipped;1;1;en\n")).toEqual([{
      market_listing_id: "7", ct_blueprint_id: 8, cm_product_id: null, name: "Bolt", set_code: "", collector_number: "",
      condition: "", language: "IT", foil: false, quantity: 3, price: "1.50", tag: "",
    }]);
  });

  it("tells a CSV download from an HTML page", () => {
    expect(looksLikeCsv(fixture("cardtrader/inventory-export.csv"))).toBe(true);
    expect(looksLikeCsv(fixture("cardtrader/export-page.html"))).toBe(false);
    expect(looksLikeCsv("anything", "text/csv; charset=utf-8")).toBe(true);
  });
});

describe("CardTrader inventory import", () => {
  it("writes creates (by blueprint, Cardmarket id or set), updates and deletes by product id", () => {
    const csv = buildImportCsv([
      change({ listing_id: 101, quantity: 2, price: "48", item: { language: "JP", foil: true } }),
      change({ listing_id: 102, price: 1.5, item: { name: "Pikachu", game: "pokemon", set_code: "SV1", collector_number: "025", cm_product_id: null, ct_blueprint_id: 7001, condition: "EX", language: "IT" } }),
      change({ listing_id: 103, quantity: 3, price: "265", item: { name: "Modern Horizons 2 Booster Box", collector_number: "", cm_product_id: null, is_product: true, foil: true } }),
      change({ listing_id: 104, action: "update", market_listing_id: "5002", price: "70", item: { condition: "LP", language: "IT" } }),
      change({ listing_id: 105, action: "delete", market_listing_id: "5003", price: "19.2", item: { condition: "M", language: "JP", foil: true } }),
    ]);
    expect(csv).toBe(fixture("cardtrader/import-expected.csv").replace(/\r?\n/g, "\r\n"));
  });
});

describe("CardTrader codes and money", () => {
  it("maps conditions, languages and amounts", () => {
    expect(conditionFromCt("Slightly Played")).toBe("EX");
    expect(conditionFromCt("heavily played")).toBe("PL");
    expect(languageFromCt("zh-CN")).toBe("ZHS");
    expect(languageFromCt("German")).toBe("DE");
    expect(parseCtMoney("€1,234.50")).toBe("1234.50");
    expect(parseCtMoney("12,30 €")).toBe("12.30");
    expect(parseCtMoney("free")).toBeNull();
  });
});

describe("CardTrader pages", () => {
  it("knows the seller, the CSRF token and the sign-in page", () => {
    expect(parseUsername(page("export-page.html"))).toBe("LedgerShop");
    expect(parseCsrfToken(page("export-page.html"))).toBe("csrf-export-1");
    expect(isSignInPage(page("logged-out.html"))).toBe(true);
    expect(isSignInPage(page("export-page.html"))).toBe(false);
    expect(parseUsername(page("logged-out.html"))).toBeNull();
    expect(isSignInUrl("https://www.cardtrader.com/users/sign_in?redirect=1")).toBe(true);
  });

  it("finds the export file, the flash messages and the orders", () => {
    expect(parseExportLink(page("export-page.html"))).toBeNull();
    expect(parseExportLink(page("export-ready.html"))).toBe("https://www.cardtrader.com/en/manage/products/exports/321/download");
    expect(parseAlerts(page("import-done.html"))).toEqual({ success: "Import completed: 4 products processed.", error: null });
    expect(parseAlerts(page("import-refused.html")).error).toMatch(/unknown column/);
    expect(parseOrdersList(page("orders-paid.html"))).toEqual(["880001", "880002"]);
    expect(URLS.orders("sent", 2)).toBe("https://www.cardtrader.com/en/orders?order_as=seller&state=sent&page=2");
  });

  it("reads an order from the JSON embedded in its page", () => {
    expect(parseOrderPage(page("order-paid.html"), "880001", "paid")).toEqual({
      market_order_id: "880001", state: "paid", buyer_username: "buyer_anna", buyer_name: "Anna Example",
      ship_name: "Anna Example", ship_street: "Example Str. 1", ship_zip: "10115", ship_city: "Berlin", ship_province: "",
      ship_country: "Germany", ship_country_code: "DE", ship_note: "", shipping_method: "Registered letter", tracked: true,
      tracking_code: "", paid_at: "2026-11-21T13:03:00.000+01:00", sent_at: null, items_total: "49.00", shipping_cost: "2.30",
      market_fee: "2.45", total: "51.30", net: "48.85", currency: "EUR",
      items: [
        { market_item_id: "99001", market_listing_id: "5001", name: "Ragavan, Nimble Pilferer", expansion: "mh2", condition: "NM",
          language: "EN", foil: false, quantity: 1, price: "48.00" },
        { market_item_id: "99002", market_listing_id: "5003", name: "Pikachu", expansion: "Scarlet & Violet", condition: "M",
          language: "JP", foil: true, quantity: 1, price: "1.00" },
      ],
    });
  });

  it("reads an order from its HTML when there is no JSON", () => {
    expect(parseOrderPage(page("order-sent.html"), "880003", "sent")).toEqual({
      market_order_id: "880003", state: "sent", buyer_username: "mtg_marco", buyer_name: "Marco Example",
      ship_name: "Marco Example", ship_street: "Via Esempio 3", ship_zip: "20121", ship_city: "Milano", ship_province: "MI",
      ship_country: "Italy", ship_country_code: "", ship_note: "", shipping_method: "Tracked letter", tracked: true,
      tracking_code: "RR123456789IT", paid_at: "2026-11-15T09:12:00+01:00", sent_at: "2026-11-16T17:40:00+01:00",
      items_total: "7.50", shipping_cost: "1.20", market_fee: "0.38", total: "8.70", net: "8.32", currency: "EUR",
      items: [{ market_item_id: "98001", market_listing_id: "5002", name: "Sheoldred, the Apocalypse", expansion: "Dominaria United",
        condition: "LP", language: "IT", foil: false, quantity: 1, price: "7.50" }],
    });
  });
});
