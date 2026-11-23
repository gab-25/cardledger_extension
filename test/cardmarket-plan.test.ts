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
    const { work, failed } = splitPlan([ok, noProduct, unknownGame, neverPublished, remove, poke], "import-zero");
    expect(work.map((w) => [w.game, w.imports.map((c) => c.listing_id), w.removals.length])).toEqual([
      ["mtg", [ok.listing_id, remove.listing_id], 0],
      ["pokemon", [poke.listing_id], 0],
    ]);
    expect(failed.map((f) => [f.listing_id, f.ok])).toEqual([[noProduct.listing_id, false], [unknownGame.listing_id, false], [neverPublished.listing_id, true]]);
    expect(splitPlan([remove], "article-form").work[0]!.removals).toEqual([remove]);
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
    const out = reconcile([create, update, remove], before, before, "bad file");
    expect(out.map((r) => [r.ok, r.error])).toEqual([
      [false, "not found on Cardmarket after the import (Cardmarket: bad file)"],
      [false, "Cardmarket shows 4 at 10.00 after the import (Cardmarket: bad file)"],
      [false, "still on Cardmarket after the removal (Cardmarket: bad file)"],
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

/** A fake agent: stock per game changes when an import comes. */
function fakeAgent(opts: { username?: string | null; afterImport?: StockRow[]; orders?: Record<string, string[]> } = {}) {
  const calls: AgentRequest[] = [];
  let stock: StockRow[] = [row("1")];
  const agent: AgentCall = async <T,>(req: AgentRequest) => {
    calls.push(req);
    switch (req.cmd) {
      case "whoami":
        return { username: opts.username === undefined ? "LedgerShop" : opts.username } as T;
      case "exportStock":
        return (req.game === "mtg" ? stock : []) as T;
      case "importStock":
        stock = opts.afterImport ?? stock;
        return { message: "1 article imported." } as T;
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

describe("runCardmarket", () => {
  it("exports, imports, re-exports and reads the orders of every game", async () => {
    const create = change({ quantity: 1, price: "10" });
    const { agent, calls } = fakeAgent({ afterImport: [row("1"), row("8")], orders: { "mtg:Paid": ["11", "12"], "mtg:Sent": ["12", "13"] } });
    const out: MarketRunOutput = { results: [] };
    await runCardmarket({ agent, plan: { market: "cm", changes: [create] }, games: ["mtg", "pokemon", "unknown"] }, out);
    expect(calls.map((c) => [c.cmd, "game" in c ? c.game : "", "state" in c ? c.state : "", "orderId" in c ? c.orderId : ""].filter(Boolean).join(" "))).toEqual([
      "whoami",
      "exportStock mtg", "importStock mtg", "exportStock mtg",
      "exportStock pokemon",
      "listOrders mtg Paid", "readOrder mtg paid 11", "readOrder mtg paid 12",
      "listOrders mtg Sent", "readOrder mtg sent 13",
      "listOrders pokemon Paid", "listOrders pokemon Sent",
    ]);
    expect(out.handle).toBe("LedgerShop");
    expect(out.results).toEqual([{ listing_id: create.listing_id, ok: true, market_listing_id: "8" }]);
    expect(out.stock!.map((s) => s.market_listing_id)).toEqual(["1", "8"]);
    expect((out.orders as OrderRow[]).map((o) => [o.market_order_id, o.state])).toEqual([["11", "paid"], ["12", "paid"], ["13", "sent"]]);
    const csv = (calls.find((c) => c.cmd === "importStock") as { csv: string }).csv;
    expect(csv.split("\r\n")[1]).toBe(";576041;1;10.00;1;NM;;;;;");
  });

  it("stops when the tab is not logged in", async () => {
    const { agent, calls } = fakeAgent({ username: null });
    await expect(runCardmarket({ agent, plan: { market: "cm", changes: [] }, games: ["mtg"] }, { results: [] })).rejects.toThrow(NOT_LOGGED_IN);
    expect(calls).toHaveLength(1);
  });
});
