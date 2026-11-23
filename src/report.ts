// The report of a run (POST /api/extension/report/) and the summary kept for the popup / sent back to the page.
// Every run produces exactly one report with a fresh uuid run_id, even when it fails (then with `error`).

import type { ChangeResult, MarketCode, MarketRunOutput, Report, ReportResponse } from "./types";

export interface Run {
  run_id: string;
  market: MarketCode;
  started_at: string;
}

export function startRun(market: MarketCode, now: Date = new Date(), uuid: () => string = () => crypto.randomUUID()): Run {
  return { run_id: uuid(), market, started_at: now.toISOString() };
}

export function buildReport(run: Run, output: MarketRunOutput, error: string | null, now: Date = new Date()): Report {
  const report: Report = {
    run_id: run.run_id,
    market: run.market,
    started_at: run.started_at,
    finished_at: now.toISOString(),
    results: output.results,
  };
  if (output.stock) report.stock = output.stock;
  if (output.orders) report.orders = output.orders;
  if (error) report.error = error;
  return report;
}

export interface RunSummary {
  run_id: string;
  market: MarketCode;
  started_at: string;
  finished_at: string;
  /** The run completed and CardLedger accepted its report. */
  ok: boolean;
  /** What went wrong on the market, if anything. */
  error?: string;
  /** The report could not be delivered to CardLedger. */
  reportError?: string;
  /** CardLedger refused the token: the extension was unpaired. */
  unauthorized?: boolean;
  handle?: string;
  changes: number;
  published: number;
  failed: number;
  stock: number | null;
  orders: number | null;
  /** First failures, for the popup. */
  failures: Array<Pick<ChangeResult, "listing_id" | "error">>;
  response?: ReportResponse;
}

const MAX_FAILURES = 20;

export function summarize(report: Report, response: ReportResponse | null, reportError: string | null, handle?: string): RunSummary {
  const failures = report.results.filter((r) => !r.ok);
  const summary: RunSummary = {
    run_id: report.run_id,
    market: report.market,
    started_at: report.started_at,
    finished_at: report.finished_at,
    ok: !report.error && !reportError,
    changes: report.results.length,
    published: report.results.length - failures.length,
    failed: failures.length,
    stock: report.stock ? report.stock.length : null,
    orders: report.orders ? report.orders.length : null,
    failures: failures.slice(0, MAX_FAILURES).map((r) => ({ listing_id: r.listing_id, error: r.error })),
  };
  if (report.error) summary.error = report.error;
  if (reportError) summary.reportError = reportError;
  if (response) summary.response = response;
  if (handle) summary.handle = handle;
  return summary;
}
