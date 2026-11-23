import { describe, expect, it } from "vitest";
import { Agent } from "../src/markets/cardmarket/agent";
import { MIN_REQUEST_GAP_MS } from "../src/markets/cardmarket/format";
import { fixture, html } from "./helpers";

type Route = { body: string; type?: string; status?: number };

/** A cardmarket.com of fixtures, with a fake clock: sleeping advances it. */
function site(routes: Record<string, Route | Route[]>) {
  let clock = 0;
  const requests: Array<{ at: number; method: string; url: string; body?: FormData }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({ at: clock, method, url, body: init.body as FormData | undefined });
    clock += 200; // network time
    const key = `${method} ${url.replace("https://www.cardmarket.com", "")}`;
    const entry = routes[key];
    const route = Array.isArray(entry) ? entry.shift() : entry;
    if (!route) return new Response("<html>missing</html>", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200, headers: { "content-type": route.type ?? "text/html" } });
  }) as typeof fetch;
  const agent = new Agent({
    fetch: fakeFetch,
    document: html(fixture("cardmarket/export-page.html")),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { agent, requests };
}

const page = (name: string): Route => ({ body: fixture(`cardmarket/${name}`) });

describe("Cardmarket agent", () => {
  it("knows who is logged in from the tab's page, without a request", async () => {
    const { agent, requests } = site({});
    expect(await agent.handle({ cmd: "whoami" })).toEqual({ ok: true, value: { username: "LedgerShop" } });
    expect(requests).toHaveLength(0);
  });

  it("exports the stock: posts the export form, waits for the file, downloads it — at a human pace", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Stock/Export": [page("export-page.html"), page("export-page.html"), page("export-ready.html")],
      "POST /en/Magic/PostGetAction/Stock_Export": page("export-page.html"),
      "GET /en/Magic/Stock/Export/File/88123": { body: fixture("cardmarket/stock-export.csv"), type: "text/csv" },
    });
    const out = await agent.handle({ cmd: "exportStock", game: "mtg" });
    expect(out.ok && (out.value as unknown[]).length).toBe(4);
    expect(requests.map((r) => `${r.method} ${r.url.replace("https://www.cardmarket.com", "")}`)).toEqual([
      "GET /en/Magic/Stock/Export",
      "POST /en/Magic/PostGetAction/Stock_Export",
      "GET /en/Magic/Stock/Export",
      "GET /en/Magic/Stock/Export",
      "GET /en/Magic/Stock/Export/File/88123",
    ]);
    expect(requests[1]!.body!.get("__cmtkn")).toBe("tok-export-1");
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.at - requests[i - 1]!.at).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
    }
  });

  it("uploads the import CSV through the form and reports Cardmarket's message", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Stock/Import": page("import-page.html"),
      "POST /en/Magic/PostGetAction/Stock_Import": page("import-done.html"),
    });
    expect(await agent.handle({ cmd: "importStock", game: "mtg", csv: "idArticle;idProduct\r\n" })).toEqual({
      ok: true, value: { message: "4 articles imported." },
    });
    const file = requests[1]!.body!.get("csvFile") as File;
    expect(await file.text()).toBe("idArticle;idProduct\r\n");
  });

  it("fails on a refused import and on a logged-out session", async () => {
    const refused = site({
      "GET /en/Magic/Stock/Import": page("import-page.html"),
      "POST /en/Magic/PostGetAction/Stock_Import": page("import-refused.html"),
    });
    expect(await refused.agent.handle({ cmd: "importStock", game: "mtg", csv: "" })).toEqual({
      ok: false, error: 'Cardmarket refused the import: The file could not be read: unknown column "Foil?".',
    });
    const out = site({ "GET /en/Magic/Orders/Sales/Paid": page("logged-out.html") });
    const res = await out.agent.handle({ cmd: "listOrders", game: "mtg", state: "Paid" });
    expect(res).toEqual({ ok: false, error: "Not logged in to Cardmarket: log in in this tab and sync again." });
  });

  it("lists sales page by page until no new order shows up", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Orders/Sales/Paid": page("sales-paid.html"),
      "GET /en/Magic/Orders/Sales/Paid?site=2": page("sales-paid.html"),
    });
    expect(await agent.handle({ cmd: "listOrders", game: "mtg", state: "Paid" })).toEqual({ ok: true, value: ["1172001", "1172002"] });
    expect(requests).toHaveLength(2);
  });

  it("reads an order and marks one shipped with its tracking number", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Orders/1172001": [page("order-paid.html"), page("order-ship.html"), page("order-ship.html")],
      "POST /en/Magic/PostGetAction/Order_SetTrackingNumber": page("import-done.html"),
      "POST /en/Magic/PostGetAction/Order_Send": page("import-done.html"),
    });
    const order = await agent.handle({ cmd: "readOrder", game: "mtg", orderId: "1172001", state: "paid" });
    expect(order.ok && (order.value as { total: string }).total).toBe("51.30");
    expect(await agent.handle({ cmd: "markShipped", game: "mtg", orderId: "1172001", trackingCode: "RR123IT" })).toEqual({ ok: true, value: undefined });
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    expect(requests[2]!.body!.get("trackingNumber")).toBe("RR123IT");
    expect(requests[4]!.body!.get("idOrder")).toBe("1172001");
  });
});
