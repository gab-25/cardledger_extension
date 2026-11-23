import { describe, expect, it } from "vitest";
import {
  NOT_FOUND,
  NOT_SOLD,
  PROPERTIES_UNKNOWN,
  applyPlan,
  orderToRow,
  ordersSince,
  productPayload,
  productToStock,
  runCardTrader,
  shipCardTrader,
} from "../src/markets/cardtrader/adapter";
import { CardTraderClient, type CtOrder } from "../src/markets/cardtrader/client";
import type { MarketRunOutput, Plan } from "../src/types";
import { change } from "./helpers";

/** A CardTrader API v2 in memory, after cardledger_core's FakeCardTrader (ledger/tests.py). */
class FakeCardTrader {
  games = [{ id: 1, name: "Magic", display_name: "Magic: the Gathering" }, { id: 5, name: "Pokemon", display_name: "Pokémon" }];
  expansions = [
    { id: 100, game_id: 1, code: "mh2", name: "Modern Horizons 2" },
    { id: 200, game_id: 5, code: "sv1", name: "Scarlet & Violet" },
  ];
  blueprints: Record<number, unknown[]> = {
    100: [
      { id: 9001, name: "Ragavan, Nimble Pilferer", card_market_ids: [576041], fixed_properties: { collector_number: "138" } },
      { id: 9002, name: "Solitude", card_market_ids: [], fixed_properties: { collector_number: "032" } },
    ],
    200: [
      {
        id: 7001, name: "Pikachu", card_market_ids: [700001], fixed_properties: { collector_number: "25" },
        editable_properties: [{ name: "condition" }, { name: "pokemon_language" }, { name: "pokemon_reverse" }],
      },
    ],
  };
  products = new Map<number, Record<string, unknown>>();
  orders: CtOrder[] = [];
  jobs = new Map<string, unknown>();
  calls: string[] = [];
  bodies: unknown[] = [];
  nextProduct = 5000;
  failBlueprints = new Set<number>();

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v2", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push(`${method} ${path}${url.search}`);
    if (body) this.bodies.push(body);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ct-token");
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (path === "/games") return json({ array: this.games });
    if (path === "/expansions") return json(this.expansions);
    if (path === "/blueprints/export") return json(this.blueprints[Number(url.searchParams.get("expansion_id"))] ?? []);
    if (path === "/products/export") return json([...this.products.values()]);
    if (path === "/products/bulk_create" || path === "/products/bulk_update") {
      const results = (body.products as Array<Record<string, unknown>>).map((p, i) => {
        if (this.failBlueprints.has(p.blueprint_id as number)) return { result: "error", job_index: i, errors: { properties: ["invalid"] } };
        const id = (p.id as number) ?? ++this.nextProduct;
        const prod = this.products.get(id) ?? { id, blueprint_id: p.blueprint_id };
        Object.assign(prod, { quantity: p.quantity, price_cents: Math.round((p.price as number) * 100), properties_hash: p.properties });
        this.products.set(id, prod);
        return { result: "ok", job_index: i, product_id: id };
      });
      const uuid = `job-${this.jobs.size}`;
      this.jobs.set(uuid, { uuid, state: "completed", results: [...results].reverse() });
      return json({ job: uuid });
    }
    if (path.startsWith("/jobs/")) return json(this.jobs.get(path.split("/").pop()!));
    if (path.startsWith("/products/") && method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!this.products.has(id)) return json({ error_code: "not_found", extra: { message: "gone" } }, 404);
      this.products.delete(id);
      return json({ result: "ok" });
    }
    if (path === "/orders") return json(url.searchParams.get("page") === "1" ? this.orders : []);
    if (path.endsWith("/tracking_code") || path.endsWith("/ship")) return json({});
    return json({ error_code: "not_found" }, 404);
  }) as typeof fetch;

  client() {
    return new CardTraderClient("ct-token", { fetch: this.fetch, sleep: async () => undefined });
  }
}

const plan = (...changes: Plan["changes"]): Plan => ({ market: "ct", changes });

describe("CardTrader plan", () => {
  it("creates Magic singles from the blueprint matched by Cardmarket product, as the server did", async () => {
    const ct = new FakeCardTrader();
    const c = change({ quantity: 2, price: "48.00", item: { language: "JP", foil: true } });
    const results = await applyPlan(ct.client(), plan(c));
    expect(results).toEqual([{ listing_id: c.listing_id, ok: true, market_listing_id: "5001" }]);
    expect(ct.calls).toEqual(["GET /expansions", "GET /games", "GET /blueprints/export?expansion_id=100", "POST /products/bulk_create", "GET /jobs/job-0"]);
    expect(ct.bodies[0]).toEqual({
      products: [{
        blueprint_id: 9001, price: 48, quantity: 2, error_mode: "strict", user_data_field: `cardledger:${c.listing_id}`,
        properties: { condition: "Near Mint", mtg_language: "jp", mtg_foil: true },
      }],
    });
  });

  it("skips resolution for Magic singles with a known blueprint and updates by product id", async () => {
    const ct = new FakeCardTrader();
    ct.products.set(77, { id: 77 });
    const create = change({ item: { ct_blueprint_id: 9002, condition: "EX", language: "IT" }, price: "21" });
    const update = change({ action: "update", market_listing_id: "77", quantity: 3, price: 5.5, item: { ct_blueprint_id: 9001 } });
    const results = await applyPlan(ct.client(), plan(create, update));
    expect(ct.calls.filter((c) => !c.startsWith("GET /jobs"))).toEqual(["POST /products/bulk_create", "POST /products/bulk_update"]);
    expect((ct.bodies[1] as { products: object[] }).products[0]).toMatchObject({ id: 77, quantity: 3, price: 5.5 });
    expect((ct.bodies[1] as { products: object[] }).products[0]).not.toHaveProperty("blueprint_id");
    expect(results.map((r) => [r.ok, r.market_listing_id])).toEqual([[true, "5001"], [true, "77"]]);
  });

  it("uses the blueprint's own property names for other games and refuses what they can't describe", async () => {
    const ct = new FakeCardTrader();
    const pika = change({ item: { game: "pokemon", set_code: "SV1", collector_number: "025", cm_product_id: null, foil: true, language: "IT" } });
    const unknownSet = change({ item: { game: "pokemon", set_code: "XXX" } });
    const notSold = change({ item: { game: "starwars", set_code: "SOR" } });
    const results = await applyPlan(ct.client(), plan(pika, unknownSet, notSold));
    expect((ct.bodies[0] as { products: object[] }).products).toEqual([
      expect.objectContaining({ blueprint_id: 7001, properties: { condition: "Near Mint", pokemon_language: "it", pokemon_reverse: true } }),
    ]);
    expect(results).toEqual([
      { listing_id: unknownSet.listing_id, ok: false, error: NOT_FOUND },
      { listing_id: notSold.listing_id, ok: false, error: NOT_SOLD },
      { listing_id: pika.listing_id, ok: true, market_listing_id: "5001" },
    ]);
  });

  it("deletes products one by one, a 404 counting as done", async () => {
    const ct = new FakeCardTrader();
    ct.products.set(10, { id: 10 });
    const gone = change({ action: "delete", market_listing_id: "10" });
    const already = change({ action: "delete", market_listing_id: "11" });
    const results = await applyPlan(ct.client(), plan(gone, already));
    expect(ct.calls).toEqual(["DELETE /products/10", "DELETE /products/11"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("reports job errors per listing", async () => {
    const ct = new FakeCardTrader();
    ct.failBlueprints.add(9001);
    const c = change();
    expect(await applyPlan(ct.client(), plan(c))).toEqual([{ listing_id: c.listing_id, ok: false, error: "properties: invalid" }]);
  });

  it("builds product payloads like services.product_payload", () => {
    const sealed = change({ item: { is_product: true, language: "DE" } });
    expect(productPayload(sealed, 1, null).properties).toEqual({ mtg_language: "de" });
    expect(productPayload(sealed, 1, ["condition"]).properties).toEqual({ condition: "Near Mint" });
    const other = change({ item: { game: "lorcana" } });
    expect(productPayload(other, 1, ["condition"]).properties).toEqual({ condition: "Near Mint" });
  });

  it("refuses other games' listings when CardTrader doesn't say their properties", async () => {
    const ct = new FakeCardTrader();
    const c = change({ action: "update", market_listing_id: "5", item: { game: "pokemon", set_code: "nope", ct_blueprint_id: 1 } });
    expect(await applyPlan(ct.client(), plan(c))).toEqual([{ listing_id: c.listing_id, ok: false, error: PROPERTIES_UNKNOWN }]);
  });
});

describe("CardTrader read back", () => {
  const order: CtOrder = {
    id: 42, code: "code42", state: "paid", buyer: { username: "buyer1" },
    paid_at: "2026-11-07T09:00:00.000Z", sent_at: null,
    seller_total: { cents: 1234, currency: "EUR" }, seller_subtotal: { cents: 1000, currency: "EUR" },
    seller_fee_amount: { cents: 50, currency: "EUR" },
    order_shipping_address: { name: "Ada", street: "Via Po 1", zip: "10100", city: "Torino", state_or_province: "TO", country: "Italy", country_code: "IT" },
    order_shipping_method: { name: "Letter", tracked: false, tracking_code: null, seller_price: { cents: 234 } },
    order_items: [{ id: 420, product_id: 5001, name: "Ragavan", expansion: "MH2", quantity: 1, seller_price: { cents: 500 },
      properties: { condition: "Slightly Played", mtg_language: "it", mtg_foil: true } }],
  };

  it("maps orders to the report format", () => {
    expect(orderToRow(order)).toMatchObject({
      market_order_id: "42", state: "paid", buyer_username: "buyer1", buyer_name: "Ada", ship_zip: "10100", ship_province: "TO",
      items_total: "10.00", shipping_cost: "2.34", market_fee: "0.50", total: "12.34", net: "11.84", currency: "EUR",
      items: [{ market_item_id: "420", market_listing_id: "5001", condition: "EX", language: "IT", foil: true, quantity: 1, price: "5.00" }],
    });
    expect(orderToRow({ ...order, state: "hub_pending" })!.state).toBe("paid");
    expect(orderToRow({ ...order, state: "done" })!.state).toBe("arrived");
    expect(orderToRow({ ...order, state: "weird" })).toBeNull();
  });

  it("maps products to stock rows", () => {
    expect(productToStock({ id: 5, blueprint_id: 9, name_en: "X", quantity: 2, price_cents: 199, expansion: { code: "mh2" },
      properties_hash: { condition: "Near Mint", pokemon_language: "zh-CN", pokemon_reverse: "true" } })).toEqual({
      market_listing_id: "5", ct_blueprint_id: 9, name: "X", set_code: "MH2", collector_number: "", condition: "NM",
      language: "ZHS", foil: true, quantity: 2, price: "1.99",
    });
  });

  it("reads orders from 14 days before the last sync", async () => {
    expect(ordersSince("2026-11-20T10:00:00Z")).toBe("2026-11-06");
    expect(ordersSince(null)).toBeNull();
    const ct = new FakeCardTrader();
    ct.orders = [order];
    const out: MarketRunOutput = { results: [] };
    await runCardTrader({ client: ct.client(), plan: plan(), lastSync: "2026-11-20T10:00:00Z" }, out);
    expect(ct.calls).toEqual(["GET /products/export", "GET /orders?page=1&limit=100&order_as=seller&sort=date.desc&from=2026-11-06"]);
    expect(out.orders).toHaveLength(1);
    expect(out.stock).toEqual([]);
  });

  it("sets the tracking code then ships", async () => {
    const ct = new FakeCardTrader();
    await shipCardTrader(ct.client(), "42", " RR123 ");
    expect(ct.calls).toEqual(["PUT /orders/42/tracking_code", "PUT /orders/42/ship"]);
    expect(ct.bodies[0]).toEqual({ tracking_code: "RR123" });
  });
});
