// CardTrader adapter: applies a CardLedger plan through CardTrader's API v2 and reads back the seller's products
// (stock) and orders. A port of what cardledger_core's ledger/services.py does on the server (resolve_blueprints,
// product_payload, undescribed_reason, _push_listings, remove_listing, upsert_order, ship_order), so listings
// published by the extension look exactly like the ones the server used to publish.

import { errorText, fromCents, normalizeNumber } from "../../lib/util";
import type {
  ChangeResult,
  MarketRunOutput,
  OrderRow,
  OrderState,
  Plan,
  PlanChange,
  PlanItem,
  StockRow,
} from "../../types";
import { CardTraderClient, CardTraderError, type CtBlueprint, type CtOrder, type CtProduct } from "./client";

export const MAGIC = "mtg";

// Ledger condition codes (Cardmarket-style grades) -> CardTrader "condition" property.
export const CONDITION_TO_CT: Record<string, string> = {
  M: "Mint",
  NM: "Near Mint",
  EX: "Slightly Played",
  GD: "Moderately Played",
  LP: "Played",
  PL: "Heavily Played",
  PO: "Poor",
};
export const CONDITION_FROM_CT: Record<string, string> = Object.fromEntries(
  Object.entries(CONDITION_TO_CT).map(([k, v]) => [v, k]),
);

// Ledger language codes -> CardTrader's language property value of every game.
export const LANGUAGE_TO_CT: Record<string, string> = {
  EN: "en", IT: "it", DE: "de", FR: "fr", ES: "es", PT: "pt", JP: "jp", KO: "ko", RU: "ru", ZHS: "zh-CN",
};
const LANGUAGE_FROM_CT: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_TO_CT).map(([k, v]) => [v.toLowerCase(), k]),
);

// Names CardTrader may give a game (GET /games), by CardLedger slug; compared normalised (gameName()).
export const CT_GAME_ALIASES: Record<string, string[]> = {
  mtg: ["magic", "magic: the gathering"],
  pokemon: ["pokémon", "pokemon"],
  lorcana: ["disney lorcana", "lorcana"],
  onepiece: ["one piece", "one piece card game"],
  yugioh: ["yu-gi-oh!", "yugioh"],
  riftbound: ["riftbound", "riftbound: league of legends trading card game"],
};

export const PROPERTIES_UNKNOWN = "CardTrader properties unknown";
export const FOIL_NOT_OFFERED = "foil not offered on CardTrader for this blueprint";
export const NOT_SOLD = "game not sold on CardTrader";
export const NOT_FOUND = "card not found in the CardTrader catalog";

const LANGUAGE_SUFFIX = "_language";
const FOIL_SUFFIXES = ["_foil", "_reverse", "_holo"];

// --- properties (ledger/ct_properties.py) ------------------------------------

/** The language property among the names CardTrader takes for a blueprint; null names: Magic's, or null. */
export function languageKey(names: string[] | null, game: string): string | null {
  if (names === null) return game === MAGIC ? `${game}${LANGUAGE_SUFFIX}` : null;
  return names.find((n) => n.endsWith(LANGUAGE_SUFFIX)) ?? null;
}

export function foilKey(names: string[] | null, game: string): string | null {
  if (names === null) return game === MAGIC ? "mtg_foil" : null;
  return names.find((n) => FOIL_SUFFIXES.some((s) => n.endsWith(s))) ?? null;
}

export function readLanguage(props: Record<string, unknown>): string {
  const entry = Object.entries(props).find(([k]) => k.endsWith(LANGUAGE_SUFFIX));
  const value = String(entry?.[1] ?? "");
  return LANGUAGE_FROM_CT[value.toLowerCase()] ?? value.toUpperCase();
}

export function readFoil(props: Record<string, unknown>): boolean {
  return Object.entries(props).some(
    ([k, v]) => FOIL_SUFFIXES.some((s) => k.endsWith(s)) && (v === true || String(v).toLowerCase() === "true"),
  );
}

function ctProperties(bp: CtBlueprint): string[] | null {
  const props = bp.editable_properties;
  if (props === null || props === undefined) return null;
  return props.filter((p) => p && typeof p === "object" && p.name).map((p) => p.name as string);
}

// --- blueprint resolution (services.resolve_blueprints) -----------------------

export interface Resolution {
  /** Plan item id -> CardTrader blueprint id (known from CardLedger or found now). */
  blueprints: Map<number, number>;
  /** Blueprint id -> property names CardTrader takes for it (null: it doesn't say). */
  properties: Map<number, string[] | null>;
  unmatched: Set<number>;
  notSold: Set<number>;
}

export function gameName(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function ctMatch(item: PlanItem, exported: CtBlueprint[]): CtBlueprint | null {
  if (item.cm_product_id) {
    const byCm = exported.find((bp) => (bp.card_market_ids ?? []).includes(item.cm_product_id as number));
    if (byCm) return byCm;
  }
  const number = normalizeNumber(item.collector_number);
  if (number && !number.startsWith("CM")) {
    return exported.find((bp) => normalizeNumber(String(bp.fixed_properties?.collector_number ?? "")) === number) ?? null;
  }
  // Several blueprints can share a name (alternate versions): keep the base one.
  let byName: CtBlueprint | null = null;
  for (const bp of exported) {
    if (bp.name.toLowerCase() === item.name.toLowerCase() && (byName === null || (byName.version && !bp.version))) byName = bp;
  }
  return byName;
}

/**
 * Find the CardTrader blueprints of the items, and what CardTrader takes for each.
 * Only the CardTrader expansions of these items (by set code, in their own game) are downloaded. Products and every
 * game but Magic are read even when the blueprint is known, for the property names (language, foil).
 * Unlike the server, an expansion is found by its code only: the plan doesn't carry the catalog expansion name.
 */
export async function resolveBlueprints(client: CardTraderClient, items: PlanItem[]): Promise<Resolution> {
  const res: Resolution = { blueprints: new Map(), properties: new Map(), unmatched: new Set(), notSold: new Set() };
  for (const item of items) if (item.ct_blueprint_id) res.blueprints.set(item.id, item.ct_blueprint_id);
  const todo = items.filter((i) => !i.ct_blueprint_id || i.is_product || i.game !== MAGIC);
  if (!todo.length) return res;

  const byCode = new Map<string, number>();
  for (const e of await client.expansions()) {
    if (e.code) {
      const key = `${e.game_id}:${e.code.toLowerCase()}`;
      if (!byCode.has(key)) byCode.set(key, e.id);
    }
  }
  const games = await client.games();
  const gameIds = new Map<string, number | null>();
  const gameId = (slug: string): number | null => {
    if (!gameIds.has(slug)) {
      const names = new Set([slug, ...(CT_GAME_ALIASES[slug] ?? [])].map(gameName).filter(Boolean));
      const found = games.find((g) => g.id !== null && g.id !== undefined && (names.has(gameName(g.name)) || names.has(gameName(g.display_name))));
      gameIds.set(slug, found ? found.id : null);
    }
    return gameIds.get(slug) ?? null;
  };

  const byExpansion = new Map<number, PlanItem[]>();
  for (const item of todo) {
    const gid = gameId(item.game);
    const expansionId = gid === null ? undefined : byCode.get(`${gid}:${item.set_code.toLowerCase()}`);
    if (expansionId === undefined) {
      if (!item.ct_blueprint_id) {
        res.unmatched.add(item.id);
        if (gid === null) res.notSold.add(item.id);
      }
      continue;
    }
    const list = byExpansion.get(expansionId) ?? [];
    list.push(item);
    byExpansion.set(expansionId, list);
  }
  for (const [expansionId, setItems] of byExpansion) {
    const exported = await client.blueprints(expansionId);
    for (const item of setItems) {
      if (item.ct_blueprint_id) {
        const known = exported.find((bp) => bp.id === item.ct_blueprint_id);
        if (known) res.properties.set(known.id, ctProperties(known));
        continue;
      }
      const bp = ctMatch(item, exported);
      if (!bp) {
        res.unmatched.add(item.id);
        continue;
      }
      res.properties.set(bp.id, ctProperties(bp));
      res.blueprints.set(item.id, bp.id);
    }
  }
  return res;
}

// --- payloads (services.product_payload / undescribed_reason) -----------------

/** Why a listing of a game other than Magic can't be put on CardTrader as it is, or null. */
export function undescribedReason(item: PlanItem, accepted: string[] | null): string | null {
  if (item.game === MAGIC) return null;
  if (accepted === null || (!item.is_product && languageKey(accepted, item.game) === null)) return PROPERTIES_UNKNOWN;
  if (item.foil && foilKey(accepted, item.game) === null) return FOIL_NOT_OFFERED;
  return null;
}

/** The CardTrader product of a plan change (create: blueprint_id; update: id). */
export function productPayload(change: PlanChange, blueprintId: number | null, accepted: string[] | null): Record<string, unknown> {
  const item = change.item;
  let language: string | null;
  let foil: string | null;
  if (item.game === MAGIC) {
    language = "mtg_language";
    foil = "mtg_foil";
    if (item.is_product && accepted !== null && !accepted.includes(language)) language = null;
  } else {
    language = languageKey(accepted, item.game);
    foil = foilKey(accepted, item.game);
  }
  const properties: Record<string, unknown> = {};
  if (item.is_product) {
    if (language) properties[language] = LANGUAGE_TO_CT[item.language];
    if (accepted !== null && accepted.includes("condition")) properties.condition = CONDITION_TO_CT[item.condition];
  } else {
    properties.condition = CONDITION_TO_CT[item.condition];
    if (language) properties[language] = LANGUAGE_TO_CT[item.language];
    if (item.foil && foil) properties[foil] = true;
  }
  const payload: Record<string, unknown> = {
    price: Number(change.price),
    quantity: change.quantity,
    properties,
    error_mode: "strict",
    user_data_field: `cardledger:${change.listing_id}`,
  };
  if (change.action === "update" && change.market_listing_id) payload.id = Number(change.market_listing_id);
  else payload.blueprint_id = blueprintId;
  return payload;
}

function jobError(result: { errors?: unknown }): string {
  const errors = result.errors;
  if (errors && typeof errors === "object" && !Array.isArray(errors)) {
    const text = Object.entries(errors as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(String).join(", ") : String(v)}`)
      .join("; ");
    return text || "unknown error";
  }
  return errors ? String(errors) : "unknown error";
}

// --- plan ------------------------------------------------------------------------

/** Apply a plan: deletes one by one (a 404 counts as done), creates and updates in one bulk job each. */
export async function applyPlan(client: CardTraderClient, plan: Plan): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];
  const upserts = plan.changes.filter((c) => c.action !== "delete");

  for (const change of plan.changes.filter((c) => c.action === "delete")) {
    if (!change.market_listing_id) {
      results.push({ listing_id: change.listing_id, ok: true });
      continue;
    }
    try {
      await client.deleteProduct(change.market_listing_id);
      results.push({ listing_id: change.listing_id, ok: true, market_listing_id: change.market_listing_id });
    } catch (exc) {
      if (exc instanceof CardTraderError && exc.status === 404) {
        results.push({ listing_id: change.listing_id, ok: true, market_listing_id: change.market_listing_id });
      } else {
        results.push({ listing_id: change.listing_id, ok: false, market_listing_id: change.market_listing_id, error: errorText(exc) });
      }
    }
  }
  if (!upserts.length) return results;

  let resolution: Resolution;
  try {
    resolution = await resolveBlueprints(client, upserts.map((c) => c.item));
  } catch (exc) {
    for (const c of upserts) results.push({ listing_id: c.listing_id, ok: false, error: errorText(exc) });
    return results;
  }
  const toCreate: Array<{ change: PlanChange; payload: object }> = [];
  const toUpdate: Array<{ change: PlanChange; payload: object }> = [];
  for (const change of upserts) {
    const isUpdate = change.action === "update" && !!change.market_listing_id;
    const blueprintId = resolution.blueprints.get(change.item.id) ?? null;
    const accepted = blueprintId === null ? null : (resolution.properties.get(blueprintId) ?? null);
    let reason: string | null = null;
    if (!isUpdate) {
      if (resolution.notSold.has(change.item.id)) reason = NOT_SOLD;
      else if (resolution.unmatched.has(change.item.id) || blueprintId === null) reason = NOT_FOUND;
    }
    reason = reason ?? undescribedReason(change.item, accepted);
    if (reason) {
      results.push({ listing_id: change.listing_id, ok: false, error: reason });
      continue;
    }
    (isUpdate ? toUpdate : toCreate).push({ change, payload: productPayload(change, blueprintId, accepted) });
  }
  for (const [batch, call] of [
    [toCreate, (p: object[]) => client.bulkCreate(p)],
    [toUpdate, (p: object[]) => client.bulkUpdate(p)],
  ] as const) {
    if (!batch.length) continue;
    try {
      const outcomes = await call(batch.map((b) => b.payload));
      batch.forEach(({ change }, i) => {
        const outcome = outcomes[i] ?? {};
        if ((outcome.result === "ok" || outcome.result === "warning") && outcome.product_id) {
          results.push({ listing_id: change.listing_id, ok: true, market_listing_id: String(outcome.product_id) });
        } else {
          results.push({ listing_id: change.listing_id, ok: false, error: jobError(outcome) });
        }
      });
    } catch (exc) {
      for (const { change } of batch) results.push({ listing_id: change.listing_id, ok: false, error: errorText(exc) });
    }
  }
  return results;
}

// --- reading back ------------------------------------------------------------------

export function productToStock(p: CtProduct): StockRow {
  const props = p.properties_hash ?? {};
  const condition = String(props.condition ?? "");
  return {
    market_listing_id: String(p.id),
    ct_blueprint_id: p.blueprint_id ?? null,
    name: p.name_en ?? "",
    set_code: (p.expansion?.code ?? "").toUpperCase(),
    collector_number: normalizeNumber(String(props.collector_number ?? "")),
    condition: CONDITION_FROM_CT[condition] ?? condition,
    language: readLanguage(props),
    foil: readFoil(props),
    quantity: p.quantity ?? 0,
    price: fromCents(p.price_cents ?? p.price ?? 0) ?? "0.00",
  };
}

/**
 * CardTrader order states -> CardLedger's. A CardTrader Zero order counts as paid while hub_pending (as on the
 * server, where it decrements stock then); "done" (closed by CardTrader after arrival) is arrived. States not
 * listed (e.g. request_for_cancel stays as it was: we keep it paid) are mapped conservatively.
 */
export const CT_STATES: Record<string, OrderState> = {
  paid: "paid",
  hub_pending: "paid",
  request_for_cancel: "paid",
  sent: "sent",
  lost: "sent",
  closed: "sent",
  arrived: "arrived",
  done: "arrived",
  canceled: "canceled",
  cancelled: "canceled",
};

const money = (m: { cents?: number | null } | null | undefined) => fromCents(m ?? null);

export function orderToRow(o: CtOrder): OrderRow | null {
  const state = CT_STATES[o.state ?? ""];
  if (!state) return null;
  const address = o.order_shipping_address ?? {};
  const method = o.order_shipping_method ?? {};
  const total = money(o.seller_total);
  const fee = money(o.seller_fee_amount);
  return {
    market_order_id: String(o.id),
    state,
    buyer_username: o.buyer?.username ?? "",
    buyer_name: address.name ?? "",
    ship_name: address.name ?? "",
    ship_street: address.street ?? "",
    ship_zip: address.zip ?? "",
    ship_city: address.city ?? "",
    ship_province: address.state_or_province ?? "",
    ship_country: address.country ?? "",
    ship_country_code: address.country_code ?? "",
    ship_note: address.note ?? "",
    shipping_method: method.name ?? "",
    tracked: !!method.tracked,
    tracking_code: method.tracking_code ?? "",
    paid_at: o.paid_at ?? null,
    sent_at: o.sent_at ?? null,
    items_total: money(o.seller_subtotal),
    shipping_cost: money(method.seller_price),
    market_fee: fee,
    total,
    // Assumption: seller_total is what the buyer paid the seller, the fee is taken from it.
    net: total !== null && fee !== null ? (Number(total) - Number(fee)).toFixed(2) : null,
    currency: o.seller_total?.currency ?? "",
    items: (o.order_items ?? []).map((i) => {
      const props = i.properties ?? {};
      const condition = String(props.condition ?? "");
      return {
        market_item_id: String(i.id),
        market_listing_id: i.product_id ? String(i.product_id) : undefined,
        name: i.name ?? "",
        expansion: i.expansion ?? "",
        condition: CONDITION_FROM_CT[condition] ?? condition,
        language: readLanguage(props),
        foil: readFoil(props),
        quantity: i.quantity ?? 1,
        price: money(i.seller_price),
      };
    }),
  };
}

/** Orders are read from 14 days before the last sync (as the server did), all of them the first time. */
export function ordersSince(lastSync: string | null | undefined): string | null {
  if (!lastSync) return null;
  const d = new Date(lastSync);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 14);
  return d.toISOString().slice(0, 10);
}

export interface CardTraderRunInput {
  client: CardTraderClient;
  plan: Plan;
  lastSync?: string | null;
}

/** One CardTrader sync: apply the plan, then read stock and orders. Throws only on stock/orders failures. */
export async function runCardTrader({ client, plan, lastSync }: CardTraderRunInput, partial: MarketRunOutput): Promise<void> {
  partial.results = await applyPlan(client, plan);
  partial.stock = (await client.myProducts()).map(productToStock);
  partial.orders = (await client.allOrders(ordersSince(lastSync)))
    .map(orderToRow)
    .filter((o): o is OrderRow => o !== null);
}

/** Set the tracking code (if any) and mark the order shipped, as services.ship_order. */
export async function shipCardTrader(client: CardTraderClient, orderId: string, trackingCode: string): Promise<void> {
  const code = trackingCode.trim();
  if (code) await client.setTrackingCode(orderId, code);
  await client.ship(orderId);
}
