// Turning a CardLedger plan into CardTrader work, and checking the outcome — pure functions, no page access.
//
// Every change is verified against the inventory read again after the work. A created product is recognised by the
// user_data_field the import set on it ("cardledger:<listing id>", read for the new products); else by a NEW product
// (absent before) of the same card — same blueprint, else Cardmarket id, else expansion + collector number (or name) —
// with the same condition, language and foil. An update is done when the product shows the planned quantity and
// price, a delete when it is gone. The blueprint CardTrader chose is reported back (`ct_blueprint_id`).

import { normalizeNumber } from "../../lib/util";
import type { ChangeResult, PlanChange } from "../../types";
import { CT_GAMES, userDataTag, type CtStockRow } from "./format";

export const NOTHING_TO_MATCH = "nothing to find this card on CardTrader with (no blueprint, Cardmarket id or set code)";
export const GAME_UNKNOWN = "game not known on CardTrader (CT_GAMES in cardtrader/format.ts)";

export interface CtWork {
  /** Creates, by CardTrader game id (one import per game). */
  creates: Map<number, PlanChange[]>;
  updates: PlanChange[];
  deletes: PlanChange[];
}

/** The changes CardTrader can take, and the ones that fail (or are trivially done) right away. */
export function splitPlan(changes: PlanChange[]): CtWork & { failed: ChangeResult[] } {
  const out: CtWork & { failed: ChangeResult[] } = { creates: new Map(), updates: [], deletes: [], failed: [] };
  for (const change of changes) {
    const item = change.item;
    const fail = (error: string) => out.failed.push({ listing_id: change.listing_id, ok: false, error });
    if (change.action === "delete") {
      if (!change.market_listing_id) out.failed.push({ listing_id: change.listing_id, ok: true }); // never published
      else out.deletes.push(change);
      continue;
    }
    if (change.action === "update" && change.market_listing_id) {
      out.updates.push(change);
      continue;
    }
    const gameId = CT_GAMES[item.game];
    if (!gameId) {
      fail(GAME_UNKNOWN);
      continue;
    }
    if (!item.ct_blueprint_id && !item.cm_product_id && !item.set_code) {
      fail(NOTHING_TO_MATCH);
      continue;
    }
    out.creates.set(gameId, [...(out.creates.get(gameId) ?? []), change]);
  }
  return out;
}

const samePrice = (a: string | number, b: string | number) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const lower = (s: string) => s.trim().toLowerCase();

/** Is this exported product the card of the change (identity, then the copy's attributes)? */
export function sameCard(row: CtStockRow, change: PlanChange): boolean {
  const item = change.item;
  let card: boolean;
  if (item.ct_blueprint_id && row.ct_blueprint_id) card = row.ct_blueprint_id === item.ct_blueprint_id;
  else if (item.cm_product_id && row.cm_product_id) card = row.cm_product_id === item.cm_product_id;
  else if (row.set_code !== item.set_code.toUpperCase()) card = false;
  else if (item.collector_number && row.collector_number) card = row.collector_number === normalizeNumber(item.collector_number);
  else card = lower(row.name) === lower(item.name);
  if (!card) return false;
  if (row.language !== item.language) return false;
  return item.is_product || (row.condition === item.condition && row.foil === item.foil);
}

/**
 * Results of the changes, comparing the inventory before and after the work.
 * notes: per listing id, a message to add to its failure (e.g. what CardTrader answered to its action).
 */
export function reconcile(changes: PlanChange[], before: CtStockRow[], after: CtStockRow[], notes: Record<number, string> = {}): ChangeResult[] {
  const beforeIds = new Set(before.map((r) => r.market_listing_id));
  const afterById = new Map(after.map((r) => [r.market_listing_id, r]));
  const claimed = new Set<string>();
  const failure = (change: PlanChange, error: string): ChangeResult => ({
    listing_id: change.listing_id,
    ok: false,
    ...(change.market_listing_id ? { market_listing_id: change.market_listing_id } : {}),
    error: notes[change.listing_id] ? `${error} (${notes[change.listing_id]})` : error,
  });
  const success = (change: PlanChange, row: CtStockRow): ChangeResult => {
    claimed.add(row.market_listing_id);
    const result: ChangeResult = { listing_id: change.listing_id, ok: true, market_listing_id: row.market_listing_id };
    if (row.ct_blueprint_id && row.ct_blueprint_id !== change.item.ct_blueprint_id) result.ct_blueprint_id = row.ct_blueprint_id;
    return result;
  };
  const fresh = (change: PlanChange) => {
    const unclaimed = after.filter((r) => !claimed.has(r.market_listing_id));
    const tag = userDataTag(change.listing_id);
    return (
      unclaimed.find((r) => r.tag === tag) ??
      unclaimed.find((r) => !beforeIds.has(r.market_listing_id) && !r.tag.startsWith("cardledger:") && sameCard(r, change)) ??
      unclaimed.find((r) => !beforeIds.has(r.market_listing_id) && sameCard(r, change))
    );
  };
  const matchesPlan = (row: CtStockRow, change: PlanChange) => row.quantity === change.quantity && samePrice(row.price, change.price);

  const results: ChangeResult[] = [];
  // Updates first: they claim the products they still own before creates look for new ones.
  const ordered = [...changes].sort((a, b) => Number(a.action === "create") - Number(b.action === "create"));
  for (const change of ordered) {
    if (change.action === "delete" || (change.action === "update" && change.quantity <= 0)) {
      results.push(
        afterById.has(change.market_listing_id)
          ? failure(change, "still on CardTrader after the removal")
          : { listing_id: change.listing_id, ok: true, market_listing_id: change.market_listing_id },
      );
      continue;
    }
    if (change.action === "update" && change.market_listing_id) {
      const row = afterById.get(change.market_listing_id);
      if (row) {
        claimed.add(row.market_listing_id);
        results.push(matchesPlan(row, change) ? success(change, row) : failure(change, `CardTrader shows ${row.quantity} at ${row.price} after the edit`));
        continue;
      }
    }
    const row = fresh(change);
    if (row && matchesPlan(row, change)) results.push(success(change, row));
    else if (row) results.push(failure(change, `CardTrader shows ${row.quantity} at ${row.price} after the edit`));
    else results.push(failure(change, change.action === "create" ? "not found on CardTrader after the import" : "product not on CardTrader anymore"));
  }
  const order = new Map(changes.map((c, i) => [c.listing_id, i]));
  return results.sort((a, b) => (order.get(a.listing_id) ?? 0) - (order.get(b.listing_id) ?? 0));
}
