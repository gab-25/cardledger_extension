import { describe, expect, it } from "vitest";
import { CardTraderAgent, NOT_LOGGED_IN } from "../src/markets/cardtrader/agent";
import { IMPORT_POLL_GAP_MS, INDEX_SETTLE_MS, MIN_REQUEST_GAP_MS } from "../src/markets/cardtrader/format";
import { fixture, html } from "./helpers";

type Route = { body: string; type?: string; status?: number; url?: string };

/** A www.cardtrader.com of fixtures, with a fake clock: sleeping advances it. */
function site(routes: Record<string, Route | Route[]>) {
  let clock = 0;
  const requests: Array<{ at: number; method: string; url: string; body?: BodyInit | null; headers: Record<string, string> }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({ at: clock, method, url, body: init.body, headers: (init.headers ?? {}) as Record<string, string> });
    clock += 200; // network time
    const entry = routes[`${method} ${url.replace("https://www.cardtrader.com", "")}`];
    const route = Array.isArray(entry) ? entry.shift() : entry;
    if (!route) return new Response("<html>missing</html>", { status: 404 });
    const resp = new Response(route.status === 204 ? null : route.body, { status: route.status ?? 200, headers: { "content-type": route.type ?? "text/html" } });
    if (route.url) Object.defineProperty(resp, "url", { value: route.url });
    return resp;
  }) as typeof fetch;
  const agent = new CardTraderAgent({
    fetch: fakeFetch,
    document: html(fixture("cardtrader/home.html")),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const paths = () => requests.map((r) => `${r.method} ${r.url.replace("https://www.cardtrader.com", "")}`);
  return { agent, requests, paths, clock: () => clock };
}

const page = (name: string): Route => ({ body: fixture(`cardtrader/${name}`) });
const json = (name: string): Route => ({ body: fixture(`cardtrader/${name}`), type: "application/json; charset=utf-8" });
const edit = { quantity: 2, price: "12.5", condition: "EX", language: "IT", foil: true, comment: "light wear", isProduct: false };
const form = (body: BodyInit | null | undefined) => body as FormData;

describe("CardTrader agent", () => {
  it("knows who is logged in from the tab's page, without a request", async () => {
    const { agent, requests } = site({});
    expect(await agent.handle({ cmd: "whoami" })).toEqual({ ok: true, value: { username: "ledgershop" } });
    expect(requests).toHaveLength(0);
  });

  it("reads the inventory from My items' JSON, page by page — at a human pace", async () => {
    const first = JSON.parse(fixture("cardtrader/inventory-page.json"));
    const { agent, requests, paths } = site({
      "GET /en-EU/users/ledgershop.json?page=1": { body: JSON.stringify({ ...first, products_last_page_reached: false }), type: "application/json" },
      "GET /en-EU/users/ledgershop.json?page=2": { body: JSON.stringify({ ...first, products: [{ ...first.products[0], id: 2 }] }), type: "application/json" },
    });
    const out = await agent.handle({ cmd: "readInventory" });
    expect(out.ok && (out.value as Array<{ market_listing_id: string }>).map((r) => r.market_listing_id)).toEqual(["474097907", "2"]);
    expect(paths()).toEqual(["GET /en-EU/users/ledgershop.json?page=1", "GET /en-EU/users/ledgershop.json?page=2"]);
    expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
  });

  it("reads products as they are now, with their tag (null when deleted)", async () => {
    const { agent } = site({ "GET /en-EU/products/474097907.json": json("product.json") });
    const out = await agent.handle({ cmd: "readProducts", productIds: ["474097907", "5"] });
    expect(out).toMatchObject({ ok: true, value: { "474097907": { market_listing_id: "474097907", price: "99.00", tag: "cardledger:test" }, "5": null } });
  });

  it("waits for the inventory index to settle when asked", async () => {
    const { agent, requests, clock } = site({ "GET /en-EU/users/ledgershop.json?page=1": json("inventory-page.json") });
    await agent.handle({ cmd: "readInventory", settle: true });
    expect(requests[0]!.at).toBeGreaterThanOrEqual(INDEX_SETTLE_MS);
    expect(clock()).toBeGreaterThan(0);
  });

  it("imports: uploads the CSV, names its columns (adding, never replacing), waits for the import to end", async () => {
    const { agent, requests, paths } = site({
      "GET /en-EU/product_imports/new": page("import-new.html"),
      "POST /en-EU/product_imports": { ...page("import-edit.html"), url: "https://www.cardtrader.com/en-EU/product_imports/9474248/edit" },
      "POST /en-EU/product_imports/9474248": page("import-processing.html"),
      "GET /en-EU/product_imports/9474248": [page("import-processing.html"), page("import-result.html")],
    });
    expect(await agent.handle({ cmd: "importProducts", gameId: 5, columns: ["mkm_id", "quantity"], csv: "mkm_id,quantity\r\n1,1\r\n" })).toEqual({
      ok: true, value: { message: "1 rows, 0 with errors, 0 with warnings, 1 items created", errors: 0 },
    });
    expect(paths()).toEqual([
      "GET /en-EU/product_imports/new", "POST /en-EU/product_imports", "POST /en-EU/product_imports/9474248",
      "GET /en-EU/product_imports/9474248", "GET /en-EU/product_imports/9474248",
    ]);
    const upload = form(requests[1]!.body);
    expect(upload.get("authenticity_token")).toBe("tok-ct-1");
    expect(await (upload.get("product_import[csv]") as File).text()).toBe("mkm_id,quantity\r\n1,1\r\n");
    const mapping = form(requests[2]!.body);
    expect(mapping.get("_method")).toBe("patch");
    expect(mapping.get("product_import[game_id]")).toBe("5");
    expect(mapping.get("product_import[replace_stock]")).toBe("false");
    expect(mapping.getAll("product_import[csv_column_names][]")).toEqual(["mkm_id", "quantity"]);
    expect(requests[3]!.at - requests[2]!.at).toBeGreaterThanOrEqual(IMPORT_POLL_GAP_MS);
  });

  it("edits a product as the edit panel does, with the page's CSRF token", async () => {
    const { agent, requests, paths } = site({
      "GET /en-EU/products/474097907.json": json("product.json"),
      "PATCH /en-EU/cards/1609/474097907.json": json("product-updated.json"),
    });
    expect(await agent.handle({ cmd: "updateProduct", productId: "474097907", blueprintId: 1609, ...edit })).toEqual({ ok: true, value: undefined });
    expect(paths()).toEqual(["GET /en-EU/products/474097907.json", "PATCH /en-EU/cards/1609/474097907.json"]);
    expect(requests[1]!.headers["X-CSRF-Token"]).toBe("csrf-ct-1");
    expect(JSON.parse(String(requests[1]!.body))).toEqual({
      authenticity_token: "csrf-ct-1",
      product: {
        graded: false, description: "light wear", tag: "", quantity: 2, price: "12.50", prop_condition: "Slightly Played",
        prop_mtg_language: "it", prop_mtg_foil: "true", prop_signed: "false", prop_altered: "false",
      },
    });
  });

  it("deletes a product, and reports CardTrader's refusal", async () => {
    const { agent, requests } = site({ "DELETE /en-EU/cards/1609/474097907.json": { body: "", status: 204 } });
    expect(await agent.handle({ cmd: "deleteProduct", productId: "474097907", blueprintId: 1609 })).toEqual({ ok: true, value: undefined });
    expect(requests[0]!.headers["X-CSRF-Token"]).toBe("csrf-ct-1");
    const refused = site({ "DELETE /en-EU/cards/1609/1.json": { body: '{"error":"Not yours"}', status: 403, type: "application/json" } });
    expect(await refused.agent.handle({ cmd: "deleteProduct", productId: "1", blueprintId: 1609 })).toEqual({
      ok: false, error: "CardTrader DELETE https://www.cardtrader.com/en-EU/cards/1609/1.json failed (403): Not yours",
    });
  });

  it("fails on a logged-out session (page or redirect)", async () => {
    const out = site({ "GET /en-EU/orders?order_as=seller&state=paid": page("logged-out.html") });
    expect(await out.agent.handle({ cmd: "listOrders", state: "paid" })).toEqual({ ok: false, error: NOT_LOGGED_IN });
    const redirected = site({
      "GET /en-EU/orders/1": { body: "<html></html>", url: "https://www.cardtrader.com/users/sign_in" },
    });
    expect(await redirected.agent.handle({ cmd: "readOrder", orderId: "1", state: "paid" })).toEqual({ ok: false, error: NOT_LOGGED_IN });
  });

  it("lists orders page by page until no new order shows up", async () => {
    const { agent, paths } = site({
      "GET /en-EU/orders?order_as=seller&state=sent": page("orders-paid.html"),
      "GET /en-EU/orders?order_as=seller&state=sent&page=2": page("orders-paid.html"),
    });
    expect(await agent.handle({ cmd: "listOrders", state: "sent" })).toEqual({ ok: true, value: ["880001", "880002"] });
    expect(paths()).toHaveLength(2);
  });

  it("reads an order and marks one shipped with its tracking code through the page's forms", async () => {
    const { agent, requests } = site({
      "GET /en-EU/orders/880001": [page("order-paid.html"), page("order-ship.html"), page("order-ship.html")],
      "POST /en-EU/orders/880001/tracking_code": page("import-result.html"),
      "POST /en-EU/orders/880001/ship": page("import-result.html"),
    });
    const order = await agent.handle({ cmd: "readOrder", orderId: "880001", state: "paid" });
    expect(order.ok && (order.value as { total: string }).total).toBe("51.30");
    expect(await agent.handle({ cmd: "markShipped", orderId: "880001", trackingCode: " RR123IT " })).toEqual({ ok: true, value: undefined });
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    expect(form(requests[2]!.body).get("order[tracking_code]")).toBe("RR123IT");
    expect(form(requests[2]!.body).get("_method")).toBe("patch");
    expect(form(requests[4]!.body).get("_method")).toBe("put");
  });

  it("uses the order page's JSON calls, with its CSRF token, when it has no forms", async () => {
    const { agent, requests, paths } = site({
      "GET /en-EU/orders/880001": page("order-paid.html"),
      "PUT /en-EU/orders/880001/tracking_code": { body: "{}", type: "application/json" },
      "PUT /en-EU/orders/880001/ship": { body: "{}", type: "application/json" },
    });
    expect(await agent.handle({ cmd: "markShipped", orderId: "880001", trackingCode: "RR9" })).toEqual({ ok: true, value: undefined });
    expect(paths()).toEqual(["GET /en-EU/orders/880001", "PUT /en-EU/orders/880001/tracking_code", "PUT /en-EU/orders/880001/ship"]);
    expect(requests[1]!.headers["X-CSRF-Token"]).toBe("csrf-order-1");
    expect(JSON.parse(String(requests[1]!.body))).toEqual({ tracking_code: "RR9" });

    const failing = site({
      "GET /en-EU/orders/880001": page("order-paid.html"),
      "PUT /en-EU/orders/880001/ship": { body: '{"error":"Order already shipped"}', status: 422, type: "application/json" },
    });
    expect(await failing.agent.handle({ cmd: "markShipped", orderId: "880001", trackingCode: "" })).toEqual({
      ok: false, error: "CardTrader PUT https://www.cardtrader.com/en-EU/orders/880001/ship failed (422): Order already shipped",
    });
  });
});
