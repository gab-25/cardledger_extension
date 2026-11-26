import { describe, expect, it } from "vitest";
import {
  URLS,
  buildImportCsv,
  conditionFromCt,
  editBody,
  isSignInPage,
  isSignInUrl,
  languageFromCt,
  parseCsrfToken,
  parseCtMoney,
  parseImportStatus,
  parseInventoryPage,
  parseOrderPage,
  parseOrdersList,
  parseUsername,
  toCtStockRow,
  toStockRow,
} from "../src/markets/cardtrader/format";
import { change, fixture, html } from "./helpers";

const page = (name: string) => html(fixture(`cardtrader/${name}`));

describe("CardTrader inventory (real answers)", () => {
  it("reads My items' JSON into stock rows", () => {
    const { rows, last } = parseInventoryPage(JSON.parse(fixture("cardtrader/inventory-page.json")));
    expect(last).toBe(true);
    expect(rows).toEqual([{
      market_listing_id: "474097907", ct_blueprint_id: 1609, cm_product_id: null, name: "Llanowar Elves", set_code: "DOM",
      collector_number: "168", condition: "NM", language: "EN", foil: false, quantity: 1, price: "99.00", tag: "",
    }]);
    expect(toStockRow(rows[0]!)).not.toHaveProperty("tag");
    expect(() => parseInventoryPage({ error: "x" })).toThrow("no products");
  });

  it("reads a product's JSON with its tag, and builds the edit panel's body from it", () => {
    const { product } = JSON.parse(fixture("cardtrader/product.json"));
    expect(toCtStockRow(product)).toMatchObject({ market_listing_id: "474097907", tag: "cardledger:test" });
    // the real body of a price change to 98.50 on this product
    expect(editBody(product, { quantity: 1, price: "98.5", condition: "NM", language: "EN", foil: false, comment: "", isProduct: false }, "tok")).toEqual({
      authenticity_token: "tok",
      product: { graded: false, description: "", tag: "", quantity: 1, price: "98.50", prop_condition: "Near Mint",
        prop_mtg_language: "en", prop_mtg_foil: "false", prop_signed: "false", prop_altered: "false" },
    });
  });

  it("reads a sealed product without condition and foil", () => {
    const row = toCtStockRow({ id: 5, price_cents: 26500, quantity: 3, blueprint_id: 88, name_en: "MH2 Box", expansion: { code: "mh2" },
      properties_hash: { mtg_language: "it" } });
    expect(row).toMatchObject({ condition: "", language: "IT", foil: false, set_code: "MH2", price: "265.00", collector_number: "" });
  });
});

describe("CardTrader import", () => {
  it("writes the creates with the header of the column names", () => {
    const csv = buildImportCsv([
      change({ listing_id: 101, quantity: 2, price: "48", item: { language: "JP", foil: true } }),
      change({ listing_id: 102, price: 1.5, item: { name: "Pikachu", set_code: "SV1", collector_number: "025", cm_product_id: null, ct_blueprint_id: 7001, condition: "EX", language: "KO" } }),
      change({ listing_id: 103, quantity: 3, price: "265", item: { name: "Modern Horizons 2 Booster Box", collector_number: "", cm_product_id: null, is_product: true, foil: true } }),
    ]);
    expect(csv.split("\r\n")).toEqual([
      "blueprint_id,mkm_id,expansion_code,collector_number,name,quantity,price,condition,language,foil,user_data_field",
      ",576041,mh2,138,\"Ragavan, Nimble Pilferer\",2,48.00,Near Mint,jp,true,cardledger:101",
      "7001,,sv1,025,Pikachu,1,1.50,Slightly Played,kr,false,cardledger:102",
      ",,mh2,,Modern Horizons 2 Booster Box,3,265.00,,en,,cardledger:103",
      "",
    ]);
  });

  it("reads an import's page: processing, then its summary", () => {
    expect(parseImportStatus(page("import-processing.html")).done).toBe(false);
    expect(parseImportStatus(page("import-result.html"))).toEqual({
      done: true, rows: 1, warnings: 0, errors: 0, created: 1, message: "1 rows, 0 with errors, 0 with warnings, 1 items created",
    });
  });
});

describe("CardTrader codes and money", () => {
  it("maps conditions, languages and amounts", () => {
    expect(conditionFromCt("Slightly Played")).toBe("EX");
    expect(conditionFromCt("heavily played")).toBe("PL");
    expect(conditionFromCt("Played")).toBe("LP");
    expect(languageFromCt("kr")).toBe("KO");
    expect(languageFromCt("zh-CN")).toBe("ZHS");
    expect(languageFromCt("German")).toBe("DE");
    expect(parseCtMoney("€1,234.50")).toBe("1234.50");
    expect(parseCtMoney("12,30 €")).toBe("12.30");
    expect(parseCtMoney("free")).toBeNull();
  });
});

describe("CardTrader pages", () => {
  it("knows the seller, the CSRF token and the sign-in page", () => {
    expect(parseUsername(page("home.html"))).toBe("ledgershop");
    expect(parseCsrfToken(page("home.html"))).toBe("csrf-ct-1");
    expect(isSignInPage(page("logged-out.html"))).toBe(true);
    expect(isSignInPage(page("home.html"))).toBe(false);
    expect(parseUsername(page("logged-out.html"))).toBeNull();
    expect(isSignInUrl("https://www.cardtrader.com/users/sign_in?redirect=1")).toBe(true);
  });

  it("finds the orders", () => {
    expect(parseOrdersList(page("orders-paid.html"))).toEqual(["880001", "880002"]);
    expect(URLS.orders("sent", 2)).toBe("https://www.cardtrader.com/en-EU/orders?order_as=seller&state=sent&page=2");
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
