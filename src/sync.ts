// One user-initiated sync of a market: fetch the plan from CardLedger, run the market's adapter, report the result.
// Nothing here is scheduled: runSync() is only called when the user presses Sync (popup or CardLedger page).

import { ApiError, type CardLedgerClient } from "./api/cardledger";
import { errorText } from "./lib/util";
import { runCardmarket, shipCardmarket, type AgentCall } from "./markets/cardmarket/adapter";
import { runCardTrader, shipCardTrader, type CtAgentCall } from "./markets/cardtrader/adapter";
import { buildReport, startRun, summarize, type RunSummary } from "./report";
import type { MarketCode, MarketRunOutput, ReportResponse } from "./types";

export interface SyncDeps {
  api: CardLedgerClient;
  /** The agent of the user's www.cardtrader.com tab (throws when there is none). */
  cardtrader: () => Promise<CtAgentCall>;
  /** The agent of the user's cardmarket.com tab (throws when there is none). */
  cardmarket: () => Promise<AgentCall>;
  now?: () => Date;
  uuid?: () => string;
}

export async function runSync(market: MarketCode, deps: SyncDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const run = startRun(market, now(), deps.uuid);
  const output: MarketRunOutput = { results: [] };
  let error: string | null = null;
  try {
    if (market === "ct") {
      const agent = await deps.cardtrader();
      const plan = await deps.api.plan("ct");
      await runCardTrader({ agent, plan }, output);
    } else {
      const agent = await deps.cardmarket();
      const plan = await deps.api.plan("cm");
      await runCardmarket({ agent, plan, games: plan.games ?? [] }, output);
    }
  } catch (exc) {
    error = errorText(exc) || "Unknown error";
  }
  const report = buildReport(run, output, error, now());
  let response: ReportResponse | null = null;
  let reportError: string | null = null;
  let unauthorized = false;
  try {
    response = await deps.api.report(report);
  } catch (exc) {
    unauthorized = exc instanceof ApiError && exc.unauthorized;
    reportError = unauthorized ? `${errorText(exc)} — pair the extension again.` : errorText(exc);
  }
  const summary = summarize(report, response, reportError, output.handle);
  if (unauthorized) summary.unauthorized = true;
  return summary;
}

export interface ShipRequest {
  market: MarketCode;
  market_order_id: string;
  tracking_code: string;
  /** Cardmarket only: the CardLedger game of the order (its pages live under the game). Default mtg. */
  game?: string;
}

/** Mark an order shipped on its market, then tell CardLedger. */
export async function runShip(req: ShipRequest, deps: SyncDeps): Promise<void> {
  if (req.market === "ct") {
    await shipCardTrader(await deps.cardtrader(), req.market_order_id, req.tracking_code);
  } else {
    await shipCardmarket(await deps.cardmarket(), req.game || "mtg", req.market_order_id, req.tracking_code);
  }
  await deps.api.shipped({ market: req.market, market_order_id: req.market_order_id, tracking_code: req.tracking_code.trim() });
}
