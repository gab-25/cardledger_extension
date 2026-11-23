// Turning a CardLedger plan into Cardmarket work, and checking the outcome — pure functions, no page access.
//
// Cardmarket's import gives no per-row result we can rely on, so every change is verified against the stock exported
// right after the import: a create is done when a NEW article (absent before) of the same product, condition,
// language and foil appears; an update when the article shows the planned amount and price (or, should Cardmarket
// replace the article on edit, when a new matching one appears); a delete when the article is gone.

import type { ChangeResult, PlanChange, StockRow } from "../../types";
import { DELETE_STRATEGY, gamePath } from "./format";

export interface GameWork {
  game: string;
  /** Rows of the import CSV (creates, updates and — with "import-zero" — deletes). */
  imports: PlanChange[];
  /** Deletes done one by one on the article page ("article-form"). */
  removals: PlanChange[];
}

/** Changes grouped by game; the ones Cardmarket can't take fail right away. */
export function splitPlan(changes: PlanChange[], deleteStrategy = DELETE_STRATEGY): { work: GameWork[]; failed: ChangeResult[] } {
  const byGame = new Map<string, GameWork>();
  const failed: ChangeResult[] = [];
  for (const change of changes) {
    const fail = (error: string) => failed.push({ listing_id: change.listing_id, ok: false, error });
    try {
      gamePath(change.item.game);
    } catch (exc) {
      fail((exc as Error).message);
      continue;
    }
    if (change.action !== "delete" && !change.item.cm_product_id) {
      fail("no Cardmarket product for this item");
      continue;
    }
    if (change.action === "delete" && !change.market_listing_id) {
      failed.push({ listing_id: change.listing_id, ok: true }); // never published: nothing to remove
      continue;
    }
    const work = byGame.get(change.item.game) ?? { game: change.item.game, imports: [], removals: [] };
    if (change.action === "delete" && deleteStrategy === "article-form") work.removals.push(change);
    else work.imports.push(change);
    byGame.set(change.item.game, work);
  }
  return { work: [...byGame.values()], failed };
}

const samePrice = (a: string | number, b: string | number) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);

function matches(row: StockRow, change: PlanChange): boolean {
  const item = change.item;
  return (
    row.cm_product_id === item.cm_product_id &&
    row.condition === item.condition &&
    row.language === item.language &&
    row.foil === item.foil
  );
}

/**
 * Results of the changes of one game, comparing the stock before and after the work.
 * note: a message to add to failures (e.g. what Cardmarket said about the import).
 */
export function reconcile(changes: PlanChange[], before: StockRow[], after: StockRow[], note?: string | null): ChangeResult[] {
  const beforeIds = new Set(before.map((r) => r.market_listing_id));
  const afterById = new Map(after.map((r) => [r.market_listing_id, r]));
  const claimed = new Set<string>();
  const fresh = (change: PlanChange) =>
    after.find((r) => !beforeIds.has(r.market_listing_id) && !claimed.has(r.market_listing_id) && matches(r, change));
  const failure = (change: PlanChange, error: string): ChangeResult => ({
    listing_id: change.listing_id,
    ok: false,
    ...(change.market_listing_id ? { market_listing_id: change.market_listing_id } : {}),
    error: note ? `${error} (Cardmarket: ${note})` : error,
  });

  const results: ChangeResult[] = [];
  // Updates first: they claim the articles they still own before creates look for new ones.
  const ordered = [...changes].sort((a, b) => Number(a.action === "create") - Number(b.action === "create"));
  for (const change of ordered) {
    if (change.action === "delete") {
      results.push(
        afterById.has(change.market_listing_id)
          ? failure(change, "still on Cardmarket after the removal")
          : { listing_id: change.listing_id, ok: true, market_listing_id: change.market_listing_id },
      );
      continue;
    }
    if (change.action === "update") {
      const row = afterById.get(change.market_listing_id);
      if (row) {
        claimed.add(row.market_listing_id);
        results.push(
          row.quantity === change.quantity && samePrice(row.price, change.price)
            ? { listing_id: change.listing_id, ok: true, market_listing_id: row.market_listing_id }
            : failure(change, `Cardmarket shows ${row.quantity} at ${row.price} after the import`),
        );
        continue;
      }
    }
    const row = fresh(change);
    if (row && row.quantity === change.quantity && samePrice(row.price, change.price)) {
      claimed.add(row.market_listing_id);
      results.push({ listing_id: change.listing_id, ok: true, market_listing_id: row.market_listing_id });
    } else {
      results.push(failure(change, change.action === "create" ? "not found on Cardmarket after the import" : "article not on Cardmarket anymore"));
    }
  }
  // Back in plan order.
  const order = new Map(changes.map((c, i) => [c.listing_id, i]));
  return results.sort((a, b) => (order.get(a.listing_id) ?? 0) - (order.get(b.listing_id) ?? 0));
}
