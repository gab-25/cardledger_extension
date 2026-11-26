import { describe, expect, it } from "vitest";
import { runCardTrader, shipCardTrader, type CtAgentCall } from "../src/markets/cardtrader/adapter";
import { NOT_LOGGED_IN, type CtAgentRequest } from "../src/markets/cardtrader/agent";
import { type CtStockRow } from "../src/markets/cardtrader/format";
import { GAME_UNKNOWN, NOTHING_TO_MATCH, reconcile, splitPlan } from "../src/markets/cardtrader/plan";
import type { MarketRunOutput, OrderRow, Plan } from "../src/types";
import { change } from "./helpers";

const row = (id: string, o: Partial<CtStockRow> = {}): CtStockRow => ({
  market_listing_id: id, ct_blueprint_id: 9001, cm_product_id: 576041, name: "Ragavan, Nimble Pilferer", set_code: "MH2",
  collector_number: "138", condition: "NM", language: "EN", foil: false, quantity: 1, price: "10.00", tag: "", ...o,
});

describe("CardTrader splitPlan", () => {
  it("groups creates by game, fails what CardTrader can't find, and skips never-published deletes", () => {
    const byCm = change();
    const bySet = change({ item: { cm_product_id: null, game: "pokemon", set_code: "SV1" } });
    const noSet = change({ item: { cm_product_id: null, set_code: "" } });
    const unknownGame = change({ item: { cm_product_id: null, ct_blueprint_id: 5, game: "nope" } });
    const byBlueprint = change({ item: { cm_product_id: null, ct_blueprint_id: 5 } });
    const update = change({ action: "update", market_listing_id: "7", item: { cm_product_id: null, set_code: "" } });
    const neverPublished = change({ action: "delete" });
    const remove = change({ action: "delete", market_listing_id: "5" });
    const out = splitPlan([byCm, bySet, noSet, unknownGame, byBlueprint, update, neverPublished, remove]);
    expect([...out.creates].map(([game, cs]) => [game, cs.map((c) => c.listing_id)])).toEqual([
      [1, [byCm.listing_id, byBlueprint.listing_id]],
      [5, [bySet.listing_id]],
    ]);
    expect(out.updates).toEqual([update]);
    expect(out.deletes).toEqual([remove]);
    expect(out.failed).toEqual([
      { listing_id: noSet.listing_id, ok: false, error: NOTHING_TO_MATCH },
      { listing_id: unknownGame.listing_id, ok: false, error: GAME_UNKNOWN },
      { listing_id: neverPublished.listing_id, ok: true },
    ]);
  });
});

describe("CardTrader reconcile", () => {
  const before = [row("1"), row("2", { quantity: 4 }), row("3")];

  it("finds created products by their tag, reporting the blueprint CardTrader chose", () => {
    const create = change({ quantity: 2, price: "12.5" });
    const update = change({ action: "update", market_listing_id: "2", quantity: 3, price: "10", item: { ct_blueprint_id: 9001 } });
    const remove = change({ action: "delete", market_listing_id: "3" });
    const after = [
      row("1"), row("2", { quantity: 3 }),
      row("8", { quantity: 2, price: "12.50" }), // same card, but not ours: the tagged one wins
      row("9", { quantity: 2, price: "12.50", ct_blueprint_id: 9002, tag: `cardledger:${create.listing_id}` }),
    ];
    expect(reconcile([create, update, remove], before, after)).toEqual([
      { listing_id: create.listing_id, ok: true, market_listing_id: "9", ct_blueprint_id: 9002 },
      { listing_id: update.listing_id, ok: true, market_listing_id: "2" },
      { listing_id: remove.listing_id, ok: true, market_listing_id: "3" },
    ]);
  });

  it("falls back to a new product of the same card when the export has no tag", () => {
    const pika = change({ quantity: 1, price: "1.5", item: { cm_product_id: null, game: "pokemon", set_code: "SV1", collector_number: "025", name: "Pikachu", language: "IT", foil: true } });
    const box = change({ quantity: 3, price: "265", item: { cm_product_id: null, collector_number: "", name: "MH2 Box", is_product: true, condition: "NM" } });
    const after = [
      ...before,
      row("10", { ct_blueprint_id: 7001, cm_product_id: null, set_code: "SV1", collector_number: "25", name: "Pikachu", language: "IT", foil: false, price: "1.50" }),
      row("11", { ct_blueprint_id: 7001, cm_product_id: null, set_code: "SV1", collector_number: "25", name: "Pikachu", language: "IT", foil: true, price: "1.50" }),
      row("12", { ct_blueprint_id: 8800, cm_product_id: null, collector_number: "", name: "mh2 box", condition: "", quantity: 3, price: "265.00" }),
    ];
    expect(reconcile([pika, box], before, after)).toEqual([
      { listing_id: pika.listing_id, ok: true, market_listing_id: "11", ct_blueprint_id: 7001 },
      { listing_id: box.listing_id, ok: true, market_listing_id: "12", ct_blueprint_id: 8800 },
    ]);
  });

  it("fails what doesn't show up, with CardTrader's message", () => {
    const create = change({ item: { foil: true } });
    const update = change({ action: "update", market_listing_id: "2", quantity: 3 });
    const gone = change({ action: "update", market_listing_id: "77" });
    const remove = change({ action: "delete", market_listing_id: "3" });
    expect(reconcile([create, update, gone, remove], before, before, { [create.listing_id]: "bad file", [remove.listing_id]: "refused" })).toEqual([
      { listing_id: create.listing_id, ok: false, error: "not found on CardTrader after the import (bad file)" },
      { listing_id: update.listing_id, ok: false, market_listing_id: "2", error: "CardTrader shows 4 at 10.00 after the edit" },
      { listing_id: gone.listing_id, ok: false, market_listing_id: "77", error: "product not on CardTrader anymore" },
      { listing_id: remove.listing_id, ok: false, market_listing_id: "3", error: "still on CardTrader after the removal (refused)" },
    ]);
  });
});

/** A fake agent: answers commands from canned values and records them. */
function fakeAgent(answers: Partial<Record<CtAgentRequest["cmd"], unknown[] | ((req: CtAgentRequest) => unknown)>>) {
  const seen: CtAgentRequest[] = [];
  const agent: CtAgentCall = async <T,>(req: CtAgentRequest): Promise<T> => {
    seen.push(req);
    const a = answers[req.cmd];
    const value = typeof a === "function" ? a(req) : a?.shift();
    if (value instanceof Error) throw value;
    return value as T;
  };
  return { agent, seen };
}

const plan = (...changes: Plan["changes"]): Plan => ({ market: "ct", changes });
const order = (id: string, state: OrderRow["state"]) => ({ market_order_id: id, state }) as OrderRow;

describe("runCardTrader", () => {
  it("reads the inventory, imports creates per game, edits and deletes, verifies, then reads paid and sent orders", async () => {
    const before = [row("1", { quantity: 4 }), row("2"), row("3", { ct_blueprint_id: 9100 })];
    const update = change({ action: "update", market_listing_id: "1", quantity: 2, price: "9", comment: "c" });
    const create = change({ quantity: 1, price: "48" });
    const poke = change({ quantity: 1, price: "2", item: { cm_product_id: null, game: "pokemon", set_code: "SV1", collector_number: "25" } });
    const remove = change({ action: "delete", market_listing_id: "3" });
    const zero = change({ action: "update", market_listing_id: "2", quantity: 0 });
    // the index still shows the old 1 and the deleted 3; the products read one by one are current
    const after = [row("1", { quantity: 4 }), row("3"), row("8", { price: "48.00" }), row("9", { price: "2.00", ct_blueprint_id: 7001 })];
    const { agent, seen } = fakeAgent({
      whoami: [{ username: "ledgershop" }],
      readInventory: [before, after],
      importProducts: [{ message: "1 rows, 0 with errors", errors: 0 }, { message: "1 rows, 0 with errors", errors: 0 }],
      updateProduct: [undefined],
      deleteProduct: [undefined, undefined],
      readProducts: [{
        "1": row("1", { quantity: 2, price: "9.00" }), "2": null, "3": null,
        "8": row("8", { price: "48.00", tag: `cardledger:${create.listing_id}` }),
        "9": row("9", { price: "2.00", ct_blueprint_id: 7001, tag: `cardledger:${poke.listing_id}` }),
      }],
      listOrders: (req) => ((req as { state: string }).state === "paid" ? ["1", "2"] : ["2", "3"]),
      readOrder: (req) => order((req as { orderId: string }).orderId, (req as { state: OrderRow["state"] }).state),
    });
    const out: MarketRunOutput = { results: [] };
    await runCardTrader({ agent, plan: plan(update, create, poke, remove, zero) }, out);
    expect(seen.map((r) => r.cmd)).toEqual([
      "whoami", "readInventory", "importProducts", "importProducts", "updateProduct", "deleteProduct", "deleteProduct",
      "readInventory", "readProducts", "listOrders", "readOrder", "readOrder", "listOrders", "readOrder",
    ]);
    expect(seen[2]).toMatchObject({ gameId: 1 });
    expect((seen[2] as { csv: string }).csv).toContain(`cardledger:${create.listing_id}`);
    expect(seen[3]).toMatchObject({ gameId: 5 });
    expect(seen[4]).toMatchObject({ productId: "1", blueprintId: 9001, quantity: 2, price: "9", comment: "c", language: "EN" });
    expect(seen.slice(5, 7)).toEqual([
      { cmd: "deleteProduct", productId: "2", blueprintId: 9001 },
      { cmd: "deleteProduct", productId: "3", blueprintId: 9100 },
    ]);
    expect(seen[7]).toEqual({ cmd: "readInventory", settle: true });
    expect(seen[8]).toEqual({ cmd: "readProducts", productIds: ["1", "2", "3", "8", "9"] });
    expect(out.handle).toBe("ledgershop");
    expect(out.results).toEqual([
      { listing_id: update.listing_id, ok: true, market_listing_id: "1", ct_blueprint_id: 9001 },
      { listing_id: create.listing_id, ok: true, market_listing_id: "8", ct_blueprint_id: 9001 },
      { listing_id: poke.listing_id, ok: true, market_listing_id: "9", ct_blueprint_id: 7001 },
      { listing_id: remove.listing_id, ok: true, market_listing_id: "3" },
      { listing_id: zero.listing_id, ok: true, market_listing_id: "2" },
    ]);
    expect(out.stock).toHaveLength(3);
    expect(out.stock![0]).not.toHaveProperty("tag");
    expect(out.orders!.map((o) => [o.market_order_id, o.state])).toEqual([["1", "paid"], ["2", "paid"], ["3", "sent"]]);
  });

  it("only reads the inventory once with nothing to push, and keeps an action's error on its failure", async () => {
    const quiet = fakeAgent({ whoami: [{ username: "S" }], readInventory: [[]], listOrders: () => [] });
    await runCardTrader({ agent: quiet.agent, plan: plan() }, { results: [] });
    expect(quiet.seen.map((r) => r.cmd)).toEqual(["whoami", "readInventory", "listOrders", "listOrders"]);

    const c = change();
    const broken = fakeAgent({ whoami: [{ username: "S" }], readInventory: [[], []], importProducts: [new Error("refused")], listOrders: () => [] });
    const out: MarketRunOutput = { results: [] };
    await runCardTrader({ agent: broken.agent, plan: plan(c) }, out);
    expect(out.results).toEqual([{ listing_id: c.listing_id, ok: false, error: "not found on CardTrader after the import (refused)" }]);
  });

  it("stops when not logged in", async () => {
    const { agent } = fakeAgent({ whoami: [{ username: null }] });
    await expect(runCardTrader({ agent, plan: plan() }, { results: [] })).rejects.toThrow(NOT_LOGGED_IN);
  });

  it("marks shipped on the order page", async () => {
    const { agent, seen } = fakeAgent({ whoami: [{ username: "S" }], markShipped: [undefined] });
    await shipCardTrader(agent, "880001", "RR1");
    expect(seen[1]).toEqual({ cmd: "markShipped", orderId: "880001", trackingCode: "RR1" });
  });
});
