import { describe, expect, it } from "vitest";
import {
  URLS,
  amountArgs,
  cmPrice,
  conditionFromCm,
  editFields,
  formAction,
  formData,
  languageFromCm,
  listFields,
  parseAjaxResponse,
  parseAlerts,
  parseAmountArgsPrefix,
  parseCmDate,
  parseCmMoney,
  parseOffersCategories,
  parseOffersPage,
  parseOrderPage,
  parsePagination,
  parseSalesList,
  parseUsername,
} from "../src/markets/cardmarket/format";
import { fixture, html } from "./helpers";

describe("Cardmarket offers (real pages)", () => {
  it("lists the categories with offers", () => {
    expect(parseOffersCategories(html(fixture("cardmarket/offers-index.html")))).toEqual(["Singles"]);
  });

  it("parses the rows of an offers page", () => {
    const doc = html(fixture("cardmarket/offers-singles.html"));
    expect(parseOffersPage(doc)).toEqual([{
      market_listing_id: "2212569958", cm_product_id: 319744, name: "Llanowar Elves", set_code: "DOM", collector_number: "",
      condition: "NM", language: "EN", foil: false, quantity: 1, price: "99.00",
    }]);
    expect(parsePagination(doc)).toEqual({ page: 1, pages: 2 });
    expect(parseOffersPage(html(fixture("cardmarket/offers-singles-2.html")))).toEqual([{
      market_listing_id: "2212570001", cm_product_id: 576041, name: "Ragavan, Nimble Pilferer", set_code: "MH2", collector_number: "",
      condition: "LP", language: "IT", foil: true, quantity: 3, price: "1234.50",
    }]);
    expect(parsePagination(html("<p>nothing</p>"))).toEqual({ page: 1, pages: 1 });
  });

  it("builds the +/- quantity args from the page's prefix", () => {
    const prefix = parseAmountArgsPrefix(fixture("cardmarket/offers-singles.html"))!;
    expect(prefix.startsWith("%23%11%10%0C")).toBe(true);
    expect(parseAmountArgsPrefix("<html></html>")).toBeNull();
    // the real request of a "-1" click on this article
    expect(amountArgs(prefix, "2212569958", -1)).toBe(`${prefix}eyJzaG93VXNlck9mZmVyc1JvdyI6IjEiLCJzaWduIjoiLTEiLCJpZEFydGljbGUiOiIyMjEyNTY5OTU4IiwiYW1vdW50IjoiMSJ9`);
  });

  it("reads AJAX answers", () => {
    expect(parseAjaxResponse(fixture("cardmarket/ajax-edit-ok.xml"))).toEqual({ ok: true, message: "Your request was executed successfully" });
    expect(parseAjaxResponse(fixture("cardmarket/ajax-amount-ok.xml"))).toEqual({ ok: true, message: null });
    expect(parseAjaxResponse(fixture("cardmarket/ajax-amount-removed.xml"))).toEqual({ ok: true, message: null });
    expect(parseAjaxResponse(fixture("cardmarket/logged-out.html")).ok).toBe(false);
  });

  it("fills the sell and edit forms", () => {
    const a = { price: 98.5, language: "EN", condition: "M", foil: false, comment: "" };
    expect(listFields({ ...a, quantity: 1 })).toEqual({ amount: "1", idLanguage: "1", idCondition: "1", price: "98,50", comments: "" });
    expect(editFields({ ...a, copies: 2, foil: true })).toEqual({ condition: "MT", idLanguage: "1", price: "98,50", comments: "", editAmount: "2", isFoil: "on" });
    expect(() => listFields({ ...a, quantity: 1, language: "XX" })).toThrow('Language "XX"');
    expect(() => cmPrice("0")).toThrow("Invalid price");
  });

  it("posts the real sell form to its action", () => {
    const doc = html(fixture("cardmarket/product-page.html"));
    const form = doc.querySelector<HTMLFormElement>("form#ListProductForm")!;
    expect(formData(form).get("__cmtkn")).toBe("tok-list-1");
    expect(formAction(form, URLS.product("mtg", 319744))).toBe("https://www.cardmarket.com/en/Magic/PostGetAction/Article_ListProduct");
  });
});

describe("Cardmarket codes", () => {
  it("round-trips codes", () => {
    expect(conditionFromCm("MT")).toBe("M");
    expect(conditionFromCm("light played")).toBe("LP");
    expect(languageFromCm("6")).toBe("ZHS");
    expect(languageFromCm("Italian")).toBe("IT");
  });
});

describe("Cardmarket pages", () => {
  it("reads the logged-in username, or none", () => {
    expect(parseUsername(html(fixture("cardmarket/offers-index.html")))).toBe("LedgerShop");
    expect(parseUsername(html(fixture("cardmarket/logged-out.html")))).toBeNull();
  });

  it("reads alerts", () => {
    expect(parseAlerts(html(fixture("cardmarket/list-done.html")))).toEqual({ success: "Your item(s) have been listed!", error: null });
    expect(parseAlerts(html(fixture("cardmarket/list-refused.html")))).toEqual({ success: null, error: "The price must be at least 0,02 €." });
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
