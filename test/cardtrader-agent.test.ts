import { describe, expect, it } from "vitest";
import { CardTraderAgent, NOT_LOGGED_IN } from "../src/markets/cardtrader/agent";
import { IMPORT_SETTLE_MS, MIN_REQUEST_GAP_MS } from "../src/markets/cardtrader/format";
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
    const resp = new Response(route.body, { status: route.status ?? 200, headers: { "content-type": route.type ?? "text/html" } });
    if (route.url) Object.defineProperty(resp, "url", { value: route.url });
    return resp;
  }) as typeof fetch;
  const agent = new CardTraderAgent({
    fetch: fakeFetch,
    document: html(fixture("cardtrader/export-page.html")),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const paths = () => requests.map((r) => `${r.method} ${r.url.replace("https://www.cardtrader.com", "")}`);
  return { agent, requests, paths, clock: () => clock };
}

const page = (name: string): Route => ({ body: fixture(`cardtrader/${name}`) });
const form = (body: BodyInit | null | undefined) => body as FormData;

describe("CardTrader agent", () => {
  it("knows who is logged in from the tab's page, without a request", async () => {
    const { agent, requests } = site({});
    expect(await agent.handle({ cmd: "whoami" })).toEqual({ ok: true, value: { username: "LedgerShop" } });
    expect(requests).toHaveLength(0);
  });

  it("exports the inventory: posts the export form, waits for the file, downloads it — at a human pace", async () => {
    const { agent, requests, paths } = site({
      "GET /en/manage/products/export": [page("export-page.html"), page("export-page.html"), page("export-ready.html")],
      "POST /en/manage/products/export": page("export-page.html"),
      "GET /en/manage/products/exports/321/download": { body: fixture("cardtrader/inventory-export.csv"), type: "text/csv" },
    });
    const out = await agent.handle({ cmd: "exportInventory" });
    expect(out.ok && (out.value as unknown[]).length).toBe(4);
    expect(paths()).toEqual([
      "GET /en/manage/products/export",
      "POST /en/manage/products/export",
      "GET /en/manage/products/export",
      "GET /en/manage/products/export",
      "GET /en/manage/products/exports/321/download",
    ]);
    expect(form(requests[1]!.body).get("authenticity_token")).toBe("tok-export-1");
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.at - requests[i - 1]!.at).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
    }
  });

  it("takes the export directly when the page itself is the CSV", async () => {
    const { agent, requests } = site({
      "GET /en/manage/products/export": { body: fixture("cardtrader/inventory-export.csv"), type: "text/csv" },
    });
    const out = await agent.handle({ cmd: "exportInventory" });
    expect(out.ok && (out.value as unknown[]).length).toBe(4);
    expect(requests).toHaveLength(1);
  });

  it("uploads the import CSV through the form, then lets CardTrader process it", async () => {
    const { agent, requests, clock } = site({
      "GET /en/manage/products/import": page("import-page.html"),
      "POST /en/manage/products/import": page("import-done.html"),
    });
    expect(await agent.handle({ cmd: "importInventory", csv: "id,blueprint_id\r\n" })).toEqual({
      ok: true, value: { message: "Import completed: 4 products processed." },
    });
    const body = form(requests[1]!.body);
    expect(await (body.get("import[file]") as File).text()).toBe("id,blueprint_id\r\n");
    expect(body.get("import[mode]")).toBe("update");
    expect(body.get("authenticity_token")).toBe("tok-import-7");
    expect(clock() - requests[1]!.at).toBeGreaterThanOrEqual(IMPORT_SETTLE_MS);
  });

  it("fails on a refused import and on a logged-out session (page or redirect)", async () => {
    const refused = site({
      "GET /en/manage/products/import": page("import-page.html"),
      "POST /en/manage/products/import": page("import-refused.html"),
    });
    expect(await refused.agent.handle({ cmd: "importInventory", csv: "" })).toEqual({
      ok: false, error: 'CardTrader refused the import: The file could not be imported: unknown column "foil".',
    });
    const out = site({ "GET /en/orders?order_as=seller&state=paid": page("logged-out.html") });
    expect(await out.agent.handle({ cmd: "listOrders", state: "paid" })).toEqual({ ok: false, error: NOT_LOGGED_IN });
    const redirected = site({
      "GET /en/orders/1": { body: "<html></html>", url: "https://www.cardtrader.com/users/sign_in" },
    });
    expect(await redirected.agent.handle({ cmd: "readOrder", orderId: "1", state: "paid" })).toEqual({ ok: false, error: NOT_LOGGED_IN });
  });

  it("lists orders page by page until no new order shows up", async () => {
    const { agent, paths } = site({
      "GET /en/orders?order_as=seller&state=sent": page("orders-paid.html"),
      "GET /en/orders?order_as=seller&state=sent&page=2": page("orders-paid.html"),
    });
    expect(await agent.handle({ cmd: "listOrders", state: "sent" })).toEqual({ ok: true, value: ["880001", "880002"] });
    expect(paths()).toHaveLength(2);
  });

  it("reads an order and marks one shipped with its tracking code through the page's forms", async () => {
    const { agent, requests } = site({
      "GET /en/orders/880001": [page("order-paid.html"), page("order-ship.html"), page("order-ship.html")],
      "POST /en/orders/880001/tracking_code": page("import-done.html"),
      "POST /en/orders/880001/ship": page("import-done.html"),
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
      "GET /en/orders/880001": page("order-paid.html"),
      "PUT /en/orders/880001/tracking_code": { body: "{}", type: "application/json" },
      "PUT /en/orders/880001/ship": { body: "{}", type: "application/json" },
    });
    expect(await agent.handle({ cmd: "markShipped", orderId: "880001", trackingCode: "RR9" })).toEqual({ ok: true, value: undefined });
    expect(paths()).toEqual(["GET /en/orders/880001", "PUT /en/orders/880001/tracking_code", "PUT /en/orders/880001/ship"]);
    expect(requests[1]!.headers["X-CSRF-Token"]).toBe("csrf-order-1");
    expect(JSON.parse(String(requests[1]!.body))).toEqual({ tracking_code: "RR9" });

    const failing = site({
      "GET /en/orders/880001": page("order-paid.html"),
      "PUT /en/orders/880001/ship": { body: '{"error":"Order already shipped"}', status: 422, type: "application/json" },
    });
    expect(await failing.agent.handle({ cmd: "markShipped", orderId: "880001", trackingCode: "" })).toEqual({
      ok: false, error: "CardTrader PUT https://www.cardtrader.com/en/orders/880001/ship failed (422): Order already shipped",
    });
  });
});
