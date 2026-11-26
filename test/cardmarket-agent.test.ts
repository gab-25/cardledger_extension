import { describe, expect, it } from "vitest";
import { Agent } from "../src/markets/cardmarket/agent";
import { MIN_REQUEST_GAP_MS } from "../src/markets/cardmarket/format";
import { fixture, html } from "./helpers";

type Route = { body: string; type?: string; status?: number; url?: string };

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
    const resp = new Response(route.body, { status: route.status ?? 200, headers: { "content-type": route.type ?? "text/html" } });
    if (route.url) Object.defineProperty(resp, "url", { value: route.url }); // a followed redirect
    return resp;
  }) as typeof fetch;
  const agent = new Agent({
    fetch: fakeFetch,
    document: html(fixture("cardmarket/offers-index.html")),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { agent, requests };
}

const page = (name: string): Route => ({ body: fixture(`cardmarket/${name}`) });
const xml = (name: string): Route => ({ body: fixture(`cardmarket/${name}`), type: "text/xml;charset=UTF-8" });
const path = (r: { method: string; url: string }) => `${r.method} ${r.url.replace("https://www.cardmarket.com", "")}`;
const article = { price: "12.5", language: "IT", condition: "LP", foil: true, comment: "light wear" };

describe("Cardmarket agent", () => {
  it("knows who is logged in from the tab's page, without a request", async () => {
    const { agent, requests } = site({});
    expect(await agent.handle({ cmd: "whoami" })).toEqual({ ok: true, value: { username: "LedgerShop" } });
    expect(requests).toHaveLength(0);
  });

  it("reads the stock from My Offers, category by category and page by page — at a human pace", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Stock/Offers": page("offers-index.html"),
      "GET /en/Magic/Stock/Offers/Singles": page("offers-singles.html"),
      "GET /en/Magic/Stock/Offers/Singles?site=2": page("offers-singles-2.html"),
    });
    const out = await agent.handle({ cmd: "readStock", game: "mtg" });
    expect(out.ok && (out.value as Array<{ market_listing_id: string }>).map((r) => r.market_listing_id)).toEqual(["2212569958", "2212570001"]);
    expect(requests.map(path)).toEqual([
      "GET /en/Magic/Stock/Offers",
      "GET /en/Magic/Stock/Offers/Singles",
      "GET /en/Magic/Stock/Offers/Singles?site=2",
    ]);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.at - requests[i - 1]!.at).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
    }
  });

  it("lists an article with the product page's sell form", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Products?idProduct=319744": { ...page("product-page.html"), url: "https://www.cardmarket.com/en/Magic/Products/Singles/Dominaria/Llanowar-Elves" },
      "POST /en/Magic/PostGetAction/Article_ListProduct": page("list-done.html"),
    });
    expect(await agent.handle({ cmd: "listArticle", game: "mtg", productId: 319744, quantity: 2, ...article })).toEqual({
      ok: true, value: { message: "Your item(s) have been listed!" },
    });
    const body = requests[1]!.body!;
    expect(Object.fromEntries([...body.entries()].filter(([, v]) => typeof v === "string"))).toEqual({
      __cmtkn: "tok-list-1", idAddProduct: "319744", amount: "2", idLanguage: "5", idCondition: "5",
      comments: "light wear", price: "12,50", isFoil: "X",
    });
  });

  it("fails a listing Cardmarket did not confirm", async () => {
    const { agent } = site({
      "GET /en/Magic/Products?idProduct=319744": page("product-page.html"),
      "POST /en/Magic/PostGetAction/Article_ListProduct": page("list-refused.html"),
    });
    expect(await agent.handle({ cmd: "listArticle", game: "mtg", productId: 319744, quantity: 1, ...article, foil: false })).toEqual({
      ok: false, error: "Cardmarket did not list product 319744: The price must be at least 0,02 €.",
    });
  });

  it("edits all copies of an article through the edit modal's AJAX action", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Modal/Article_EditArticleModal?showUserOffersRow=1&table=userOffers&idArticle=2212569958": page("edit-modal.html"),
      "POST /en/Magic/AjaxAction/Article_EditSingleArticle": xml("ajax-edit-ok.xml"),
    });
    expect(await agent.handle({ cmd: "editArticle", game: "mtg", articleId: "2212569958", copies: 1, ...article })).toEqual({
      ok: true, value: { message: "Your request was executed successfully" },
    });
    expect(Object.fromEntries([...requests[1]!.body!.entries()].filter(([, v]) => typeof v === "string"))).toEqual({
      __cmtkn: "tok-edit-1", idArticle: "2212569958", showUserOffersRow: "1", originTable: "userOffers",
      condition: "LP", idLanguage: "5", price: "12,50", comments: "light wear", editAmount: "1", isFoil: "on",
    });
  });

  it("changes the quantity with the offers page's +/- action (args read from the page)", async () => {
    const { agent, requests } = site({
      "GET /en/Magic/Stock/Offers": page("offers-index.html"),
      "GET /en/Magic/Stock/Offers/Singles": page("offers-singles.html"),
      "POST /en/Magic/AjaxAction": [xml("ajax-amount-ok.xml"), xml("ajax-amount-ok.xml")],
    });
    expect(await agent.handle({ cmd: "changeAmount", game: "mtg", articleId: "2212569958", delta: -1 })).toEqual({ ok: true, value: { message: null } });
    expect(await agent.handle({ cmd: "changeAmount", game: "mtg", articleId: "2212569958", delta: 3 })).toEqual({ ok: true, value: { message: null } });
    expect(requests.map(path)).toEqual(["GET /en/Magic/Stock/Offers", "GET /en/Magic/Stock/Offers/Singles", "POST /en/Magic/AjaxAction", "POST /en/Magic/AjaxAction"]);
    const args = (i: number) => String(requests[i]!.body!.get("args"));
    expect(args(2).startsWith("%23%11%10%0C")).toBe(true);
    expect(JSON.parse(atob(args(2).split("%2A%2A%2A").pop()!))).toEqual({ showUserOffersRow: "1", sign: "-1", idArticle: "2212569958", amount: "1" });
    expect(JSON.parse(atob(args(3).split("%2A%2A%2A").pop()!))).toMatchObject({ sign: "1", amount: "3" });
  });

  it("fails a refused AJAX action and a logged-out session", async () => {
    const refused = site({
      "GET /en/Magic/Modal/Article_EditArticleModal?showUserOffersRow=1&table=userOffers&idArticle=1": page("edit-modal.html"),
      "POST /en/Magic/AjaxAction/Article_EditSingleArticle": {
        body: `<?xml version="1.0" encoding="UTF-8"?><ajaxResponse><resultType>${btoa("error")}</resultType><systemMessage>${btoa("<div class='alert alert-danger'>Invalid price</div>")}</systemMessage></ajaxResponse>`,
        type: "text/xml",
      },
    });
    expect(await refused.agent.handle({ cmd: "editArticle", game: "mtg", articleId: "1", copies: 1, ...article })).toEqual({
      ok: false, error: "Cardmarket refused to edit article 1: Invalid price",
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
      "POST /en/Magic/PostGetAction/Order_SetTrackingNumber": page("list-done.html"),
      "POST /en/Magic/PostGetAction/Order_Send": page("list-done.html"),
    });
    const order = await agent.handle({ cmd: "readOrder", game: "mtg", orderId: "1172001", state: "paid" });
    expect(order.ok && (order.value as { total: string }).total).toBe("51.30");
    expect(await agent.handle({ cmd: "markShipped", game: "mtg", orderId: "1172001", trackingCode: "RR123IT" })).toEqual({ ok: true, value: undefined });
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    expect(requests[2]!.body!.get("trackingNumber")).toBe("RR123IT");
    expect(requests[4]!.body!.get("idOrder")).toBe("1172001");
  });
});
