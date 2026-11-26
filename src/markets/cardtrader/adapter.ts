// CardTrader adapter (background side): drives the agent running in the user's www.cardtrader.com tab, like the
// Cardmarket one. One sync: read the inventory, import the creates (one "Sell via spreadsheet" import per game), edit
// and delete products one by one, read the inventory again (and the tag of the new products) and verify every change
// against it (plan.ts), then read the paid and sent orders and each order page. All requests are sequential and paced.

import { errorText } from "../../lib/util";
import type { MarketRunOutput, OrderRow, Plan, PlanChange } from "../../types";
import type { AgentCall as AnyAgentCall } from "../tab";
import { NOT_LOGGED_IN, type CtAgentRequest } from "./agent";
import { IMPORT_COLUMNS, buildImportCsv, toStockRow, type CtStockRow } from "./format";
import { reconcile, splitPlan } from "./plan";

export type CtAgentCall = AnyAgentCall<CtAgentRequest>;

export interface CardTraderRunInput {
  agent: CtAgentCall;
  plan: Plan;
}

async function login(agent: CtAgentCall): Promise<string> {
  const { username } = await agent<{ username: string | null }>({ cmd: "whoami" });
  if (!username) throw new Error(NOT_LOGGED_IN);
  return username;
}

/** One CardTrader sync; what was done before a failure stays in `partial` (the caller reports it). */
export async function runCardTrader({ agent, plan }: CardTraderRunInput, partial: MarketRunOutput): Promise<void> {
  partial.handle = await login(agent);
  const { creates, updates, deletes, failed } = splitPlan(plan.changes);
  partial.results = [...failed];

  const before = await agent<CtStockRow[]>({ cmd: "readInventory" });
  let inventory = before;
  const work = [...[...creates.values()].flat(), ...updates, ...deletes];
  if (work.length) {
    const notes: Record<number, string> = {};
    const note = (changes: PlanChange[], message: string) => {
      for (const c of changes) notes[c.listing_id] = notes[c.listing_id] ? `${notes[c.listing_id]}; ${message}` : message;
    };
    for (const [gameId, changes] of creates) {
      try {
        const { message, errors } = await agent<{ message: string; errors: number }>({
          cmd: "importProducts", gameId, columns: [...IMPORT_COLUMNS], csv: buildImportCsv(changes),
        });
        if (errors) note(changes, `CardTrader import: ${message}`);
      } catch (exc) {
        note(changes, errorText(exc));
      }
    }
    for (const change of updates) {
      const current = before.find((r) => r.market_listing_id === change.market_listing_id);
      if (!current) continue; // reconcile reports it gone
      try {
        if (change.quantity <= 0) {
          await agent({ cmd: "deleteProduct", productId: current.market_listing_id, blueprintId: current.ct_blueprint_id! });
          continue;
        }
        await agent({
          cmd: "updateProduct", productId: current.market_listing_id, blueprintId: current.ct_blueprint_id!,
          quantity: change.quantity, price: change.price, condition: change.item.condition, language: change.item.language,
          foil: change.item.foil, comment: change.comment ?? "", isProduct: change.item.is_product,
        });
      } catch (exc) {
        note([change], errorText(exc));
      }
    }
    for (const change of deletes) {
      const current = before.find((r) => r.market_listing_id === change.market_listing_id);
      if (!current) continue; // already gone
      try {
        await agent({ cmd: "deleteProduct", productId: current.market_listing_id, blueprintId: current.ct_blueprint_id! });
      } catch (exc) {
        note([change], errorText(exc));
      }
    }
    // The inventory index lags behind: read the products touched (and the new ones, for their tag) one by one.
    inventory = await agent<CtStockRow[]>({ cmd: "readInventory", settle: true });
    const known = new Set(before.map((r) => r.market_listing_id));
    const touched = [...updates, ...deletes].map((c) => c.market_listing_id).filter((id) => known.has(id));
    const fresh = inventory.filter((r) => !known.has(r.market_listing_id)).map((r) => r.market_listing_id);
    const ids = [...new Set([...touched, ...fresh])];
    if (ids.length) {
      const now = await agent<Record<string, CtStockRow | null>>({ cmd: "readProducts", productIds: ids });
      inventory = inventory
        .filter((r) => now[r.market_listing_id] !== null)
        .map((r) => now[r.market_listing_id] ?? r);
      for (const id of ids) if (now[id] && !inventory.some((r) => r.market_listing_id === id)) inventory.push(now[id]!);
    }
    partial.results.push(...reconcile(plan.changes.filter((c) => work.includes(c)), before, inventory, notes));
  }
  partial.stock = inventory.map(toStockRow);

  const orders: OrderRow[] = [];
  partial.orders = orders;
  for (const state of ["paid", "sent"] as const) {
    for (const orderId of await agent<string[]>({ cmd: "listOrders", state })) {
      if (orders.some((o) => o.market_order_id === orderId)) continue;
      orders.push(await agent<OrderRow>({ cmd: "readOrder", orderId, state }));
    }
  }
}

/** Set the tracking code (if any) and mark the order shipped, on its CardTrader page. */
export async function shipCardTrader(agent: CtAgentCall, orderId: string, trackingCode: string): Promise<void> {
  await login(agent);
  await agent({ cmd: "markShipped", orderId, trackingCode });
}
