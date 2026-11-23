// Cardmarket adapter (background side): drives the agent running in the user's cardmarket.com tab.
// One sync, per game: export the stock, upload one import CSV with the plan's changes (deletes per article when
// DELETE_STRATEGY says so), export again and verify every change against it (plan.ts), then read the Paid and Sent
// sales and each of their orders. All requests are sequential and paced by the agent.

import type { MarketRunOutput, OrderRow, Plan, StockRow } from "../../types";
import { errorText } from "../../lib/util";
import type { AgentRequest } from "./agent";
import { CM_GAMES, buildImportCsv } from "./format";
import { reconcile, splitPlan } from "./plan";

/** Sends one request to the agent and returns its value (throws its error). */
export type AgentCall = <T>(req: AgentRequest) => Promise<T>;

export const NOT_LOGGED_IN = "Not logged in to Cardmarket: log in on cardmarket.com in this browser and sync again.";

export interface CardmarketRunInput {
  agent: AgentCall;
  plan: Plan;
  /** Games whose stock and orders are read even with nothing to push (from the options). */
  games: string[];
}

export async function runCardmarket({ agent, plan, games }: CardmarketRunInput, partial: MarketRunOutput): Promise<void> {
  const { username } = await agent<{ username: string | null }>({ cmd: "whoami" });
  if (!username) throw new Error(NOT_LOGGED_IN);
  partial.handle = username;

  const { work, failed } = splitPlan(plan.changes);
  partial.results = [...failed];
  const allGames = [...new Set([...work.map((w) => w.game), ...games])].filter((g) => g in CM_GAMES);
  const stock: StockRow[] = [];
  partial.stock = stock;

  for (const game of allGames) {
    const before = await agent<StockRow[]>({ cmd: "exportStock", game });
    const todo = work.find((w) => w.game === game);
    if (!todo) {
      stock.push(...before);
      continue;
    }
    const notes: string[] = [];
    if (todo.imports.length) {
      try {
        const { message } = await agent<{ message: string | null }>({ cmd: "importStock", game, csv: buildImportCsv(todo.imports) });
        if (message) notes.push(message);
      } catch (exc) {
        notes.push(errorText(exc));
      }
    }
    for (const change of todo.removals) {
      try {
        await agent({ cmd: "removeArticle", game, articleId: change.market_listing_id });
      } catch (exc) {
        notes.push(errorText(exc));
      }
    }
    const after = await agent<StockRow[]>({ cmd: "exportStock", game });
    stock.push(...after);
    partial.results.push(...reconcile([...todo.imports, ...todo.removals], before, after, notes.join("; ") || null));
  }

  const orders: OrderRow[] = [];
  partial.orders = orders;
  for (const game of allGames) {
    for (const [list, state] of [["Paid", "paid"], ["Sent", "sent"]] as const) {
      const ids = await agent<string[]>({ cmd: "listOrders", game, state: list });
      for (const orderId of ids) {
        if (orders.some((o) => o.market_order_id === orderId)) continue;
        orders.push(await agent<OrderRow>({ cmd: "readOrder", game, orderId, state }));
      }
    }
  }
}

export async function shipCardmarket(agent: AgentCall, game: string, orderId: string, trackingCode: string): Promise<void> {
  const { username } = await agent<{ username: string | null }>({ cmd: "whoami" });
  if (!username) throw new Error(NOT_LOGGED_IN);
  await agent({ cmd: "markShipped", game, orderId, trackingCode });
}
