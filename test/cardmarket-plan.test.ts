import { describe, expect, it } from "vitest";
import { runCardmarket, NOT_LOGGED_IN, type AgentCall } from "../src/markets/cardmarket/adapter";
import type { AgentRequest } from "../src/markets/cardmarket/agent";
import { reconcile, splitPlan } from "../src/markets/cardmarket/plan";
import type { MarketRunOutput, OrderRow, StockRow } from "../src/types";
import { change } from "./helpers";

const row = (id: string, o: Partial<StockRow> = {}): StockRow => ({
  market_listing_id: id, cm_product_id: 576041, name: "Ragavan", set_code: "MH2", collector_number: "138",
  condition: "NM", language: "EN", foil: false, quantity: 1, price: "10.00", ...o,
});

describe("splitPlan", () => {
  it("groups by game and fails what Cardmarket can't take", () => {
    const ok = change();
    const noProduct = change({ item: { cm_product_id: null } });
    const unknownGame = change({ item: { game: "nope" } });
    const neverPublished = change({ action: "delete" });
    const remove = change({ action: "delete", market_listing_id: "5" });
    const poke = change({ item: { game: "pokemon" } });
    const { work, failed } = splitPlan([ok, noProduct, unknownGame, neverPublished, remove, poke]);
    expect(work.map((w) => [w.game, w.changes.map((c) => c.listing_id)])).toEqual([
      ["mtg", [ok.listing_id, remove.listing_id]],
      ["pokemon", [poke.listing_id]],
    ]);
    expect(failed.map((f) => [f.listing_id, f.ok])).toEqual([[noProduct.listing_id, false], [unknownGame.listing_id, false], [neverPublished.listing_id, true]]);
  });
});

describe("reconcile", () => {
  const before = [row("1"), row("2", { quantity: 4 }), row("3")];

  it("finds created articles among the new ones, checks updates and deletes", () => {
    const create = change({ quantity: 2, price: "12.5" });
    const update = change({ action: "update", market_listing_id: "2", quantity: 3, price: "10" });
    const remove = change({ action: "delete", market_listing_id: "3" });
    const after = [row("1"), row("2", { quantity: 3 }), row("9", { quantity: 2, price: "12.50" })];
    expect(reconcile([create, update, remove], before, after)).toEqual([
      { listing_id: create.listing_id, ok: true, market_listing_id: "9" },
      { listing_id: update.listing_id, ok: true, market_listing_id: "2" },
      { listing_id: remove.listing_id, ok: true, market_listing_id: "3" },
    ]);
  });

  it("fails what doesn't show up, with Cardmarket's message", () => {
    const create = change({ item: { foil: true } });
    const update = change({ action: "update", market_listing_id: "2", quantity: 3 });
    const remove = change({ action: "delete", market_listing_id: "3" });
    const out = reconcile([create, update, remove], before, before, { [create.listing_id]: "Cardmarket did not list product 576041: bad price" });
    expect(out.map((r) => [r.ok, r.error])).toEqual([
      [false, "not found on Cardmarket after listing it (Cardmarket did not list product 576041: bad price)"],
      [false, "Cardmarket shows 4 at 10.00 after the edit"],
      [false, "still on Cardmarket after the removal"],
    ]);
  });

  it("follows an updated article that Cardmarket replaced, and never gives one article to two changes", () => {
    const update = change({ action: "update", market_listing_id: "1", price: "11" });
    const createA = change({ price: "11" });
    const after = [row("2", { quantity: 4 }), row("3"), row("7", { price: "11.00" })];
    expect(reconcile([createA, update], before, after).map((r) => [r.ok, r.market_listing_id])).toEqual([
      [false, undefined],
      [true, "7"],
    ]);
  });
});

/** A fake agent: a Cardmarket whose mtg stock follows the page actions (listing, edit, +/-). */
function fakeAgent(opts: { username?: string | null; refuse?: AgentRequest["cmd"]; orders?: Record<string, string[]> } = {}) {
  const calls: AgentRequest[] = [];
  let stock: StockRow[] = [row("1"), row("2", { quantity: 4 }), row("3", { quantity: 2 })];
  let nextId = 8;
  const agent: AgentCall = async <T,>(req: AgentRequest) => {
    calls.push(req);
    if (req.cmd === opts.refuse) throw new Error(`refused ${req.cmd}`);
    switch (req.cmd) {
      case "whoami":
        return { username: opts.username === undefined ? "LedgerShop" : opts.username } as T;
      case "readStock":
        return (req.game === "mtg" ? stock.map((r) => ({ ...r })) : []) as T;
      case "listArticle":
        stock.push(row(String(nextId++), { cm_product_id: req.productId, quantity: req.quantity, price: Number(req.price).toFixed(2),
          condition: req.condition, language: req.language, foil: req.foil }));
        return { message: "Your item(s) have been listed!" } as T;
      case "editArticle":
        stock = stock.map((r) => (r.market_listing_id === req.articleId ? { ...r, price: Number(req.price).toFixed(2), condition: req.condition } : r));
        return { message: null } as T;
      case "changeAmount":
        stock = stock
          .map((r) => (r.market_listing_id === req.articleId ? { ...r, quantity: r.quantity + req.delta } : r))
          .filter((r) => r.quantity > 0);
        return { message: null } as T;
      case "listOrders":
        return (opts.orders?.[`${req.game}:${req.state}`] ?? []) as T;
      case "readOrder":
        return { market_order_id: req.orderId, state: req.state, items: [] } as unknown as T;
      default:
        return undefined as T;
    }
  };
  return { agent, calls };
}

const describeCall = (c: AgentRequest) =>
  [c.cmd, "game" in c ? c.game : "", "articleId" in c ? c.articleId : "", "delta" in c ? String(c.delta) : "",
    "state" in c ? c.state : "", "orderId" in c ? c.orderId : ""].filter(Boolean).join(" ");

describe("runCardmarket", () => {
  it("reads the stock, applies each change with its page action, reads it again, then the orders of every game", async () => {
    const create = change({ quantity: 2, price: "10" });
    const update = change({ action: "update", market_listing_id: "2", quantity: 3, price: "9" });
    const remove = change({ action: "delete", market_listing_id: "3" });
    const gone = change({ action: "update", market_listing_id: "77", quantity: 1 });
    const { agent, calls } = fakeAgent({ orders: { "mtg:Paid": ["11", "12"], "mtg:Sent": ["12", "13"] } });
    const out: MarketRunOutput = { results: [] };
    await runCardmarket({ agent, plan: { market: "cm", changes: [create, update, remove, gone] }, games: ["mtg", "pokemon", "unknown"] }, out);
    expect(calls.map(describeCall)).toEqual([
      "whoami",
      "readStock mtg",
      "listArticle mtg",
      "editArticle mtg 2", "changeAmount mtg 2 -1",
      "changeAmount mtg 3 -2",
      "readStock mtg",
      "readStock pokemon",
      "listOrders mtg Paid", "readOrder mtg paid 11", "readOrder mtg paid 12",
      "listOrders mtg Sent", "readOrder mtg sent 13",
      "listOrders pokemon Paid", "listOrders pokemon Sent",
    ]);
    expect(calls[2]).toMatchObject({ productId: 576041, quantity: 2, price: "10", language: "EN", condition: "NM", foil: false });
    expect(calls[3]).toMatchObject({ copies: 4, price: "9" });
    expect(out.handle).toBe("LedgerShop");
    expect(out.results).toEqual([
      { listing_id: create.listing_id, ok: true, market_listing_id: "8" },
      { listing_id: update.listing_id, ok: true, market_listing_id: "2" },
      { listing_id: remove.listing_id, ok: true, market_listing_id: "3" },
      { listing_id: gone.listing_id, ok: false, market_listing_id: "77",
        error: "article not on Cardmarket anymore (article not in the Cardmarket offers)" },
    ]);
    expect(out.stock!.map((s) => [s.market_listing_id, s.quantity])).toEqual([["1", 1], ["2", 3], ["8", 2]]);
    expect((out.orders as OrderRow[]).map((o) => [o.market_order_id, o.state])).toEqual([["11", "paid"], ["12", "paid"], ["13", "sent"]]);
  });

  it("keeps going when an action is refused, and reports why", async () => {
    const create = change();
    const update = change({ action: "update", market_listing_id: "1", quantity: 1, price: "12" });
    const { agent } = fakeAgent({ refuse: "listArticle" });
    const out: MarketRunOutput = { results: [] };
    await runCardmarket({ agent, plan: { market: "cm", changes: [create, update] }, games: [] }, out);
    expect(out.results.map((r) => [r.ok, r.error])).toEqual([
      [false, "not found on Cardmarket after listing it (refused listArticle)"],
      [true, undefined],
    ]);
  });

  it("stops when the tab is not logged in", async () => {
    const { agent, calls } = fakeAgent({ username: null });
    await expect(runCardmarket({ agent, plan: { market: "cm", changes: [] }, games: ["mtg"] }, { results: [] })).rejects.toThrow(NOT_LOGGED_IN);
    expect(calls).toHaveLength(1);
  });
});
