// CardTrader adapter (background side): drives the agent running in the user's www.cardtrader.com tab, like the
// Cardmarket one. One sync: export the inventory, upload one import CSV with the plan's changes (deletes per product
// when DELETE_STRATEGY says so), export again and verify every change against it (plan.ts), then read the paid and
// sent orders and each order page. All requests are sequential and paced by the agent.

import { errorText } from "../../lib/util";
import type { MarketRunOutput, OrderRow, Plan } from "../../types";
import type { AgentCall as AnyAgentCall } from "../tab";
import { NOT_LOGGED_IN, type CtAgentRequest } from "./agent";
import { buildImportCsv, toStockRow, type CtStockRow } from "./format";
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
  const { imports, removals, failed } = splitPlan(plan.changes);
  partial.results = [...failed];

  const before = await agent<CtStockRow[]>({ cmd: "exportInventory" });
  let inventory = before;
  if (imports.length || removals.length) {
    const notes: string[] = [];
    if (imports.length) {
      try {
        const { message } = await agent<{ message: string | null }>({ cmd: "importInventory", csv: buildImportCsv(imports) });
        if (message) notes.push(message);
      } catch (exc) {
        notes.push(errorText(exc));
      }
    }
    for (const change of removals) {
      try {
        await agent({ cmd: "removeProduct", productId: change.market_listing_id });
      } catch (exc) {
        notes.push(errorText(exc));
      }
    }
    inventory = await agent<CtStockRow[]>({ cmd: "exportInventory" });
    partial.results.push(...reconcile([...imports, ...removals], before, inventory, notes.join("; ") || null));
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
