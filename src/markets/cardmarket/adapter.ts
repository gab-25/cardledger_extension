// Cardmarket adapter (background side): drives the agent running in the user's cardmarket.com tab.
// One sync, per game: read the stock ("My Offers"), apply each change of the plan with its page action (sell form,
// edit modal, +/- quantity), read the stock again and verify every change against it (plan.ts), then read the Paid
// and Sent sales and each of their orders. All requests are sequential and paced by the agent.

import type { MarketRunOutput, OrderRow, Plan, PlanChange, StockRow } from "../../types";
import { errorText } from "../../lib/util";
import type { AgentCall as AnyAgentCall } from "../tab";
import type { AgentRequest, ArticleFields } from "./agent";
import { CM_GAMES } from "./format";
import { reconcile, splitPlan } from "./plan";

/** Sends one request to the agent and returns its value (throws its error). */
export type AgentCall = AnyAgentCall<AgentRequest>;

export const NOT_LOGGED_IN = "Not logged in to Cardmarket: log in on cardmarket.com in this browser and sync again.";

export interface CardmarketRunInput {
  agent: AgentCall;
  plan: Plan;
  /** Games whose stock and orders are read even with nothing to push (the plan's `games`, decided by CardLedger). */
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
    const before = await agent<StockRow[]>({ cmd: "readStock", game });
    const todo = work.find((w) => w.game === game);
    if (!todo) {
      stock.push(...before);
      continue;
    }
    const notes: Record<number, string> = {};
    for (const change of todo.changes) {
      try {
        await applyChange(agent, game, change, before);
      } catch (exc) {
        notes[change.listing_id] = errorText(exc);
      }
    }
    const after = await agent<StockRow[]>({ cmd: "readStock", game });
    stock.push(...after);
    partial.results.push(...reconcile(todo.changes, before, after, notes));
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

/** One plan change, done with its page action (checked afterwards by reconcile). */
async function applyChange(agent: AgentCall, game: string, change: PlanChange, before: StockRow[]): Promise<void> {
  const fields: ArticleFields = {
    price: change.price,
    language: change.item.language,
    condition: change.item.condition,
    foil: change.item.foil,
    comment: change.comment ?? "",
  };
  if (change.action === "create") {
    await agent({ cmd: "listArticle", game, productId: change.item.cm_product_id!, quantity: change.quantity, ...fields });
    return;
  }
  const current = before.find((r) => r.market_listing_id === change.market_listing_id);
  if (change.action === "delete" || change.quantity <= 0) {
    if (current) await agent({ cmd: "changeAmount", game, articleId: current.market_listing_id, delta: -current.quantity });
    return;
  }
  if (!current) throw new Error("article not in the Cardmarket offers");
  await agent({ cmd: "editArticle", game, articleId: current.market_listing_id, copies: current.quantity, ...fields });
  const delta = change.quantity - current.quantity;
  if (delta) await agent({ cmd: "changeAmount", game, articleId: current.market_listing_id, delta });
}

export async function shipCardmarket(agent: AgentCall, game: string, orderId: string, trackingCode: string): Promise<void> {
  const { username } = await agent<{ username: string | null }>({ cmd: "whoami" });
  if (!username) throw new Error(NOT_LOGGED_IN);
  await agent({ cmd: "markShipped", game, orderId, trackingCode });
}
