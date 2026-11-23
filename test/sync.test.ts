import { describe, expect, it } from "vitest";
import { CardLedgerClient } from "../src/api/cardledger";
import type { AgentCall } from "../src/markets/cardmarket/adapter";
import { CardTraderClient } from "../src/markets/cardtrader/client";
import { buildReport, startRun, summarize } from "../src/report";
import { NO_CT_TOKEN, runShip, runSync, type SyncDeps } from "../src/sync";
import type { Report } from "../src/types";
import { change, jsonFetch } from "./helpers";

const BASE = "https://ledger.example.com";
const NOW = new Date("2026-11-23T10:00:00Z");
const status = { user: { username: "gab", full_name: "Gab" }, markets: [{ code: "ct", name: "CardTrader", connected: true, status: "ok", last_sync: null, handle: "" }], pending: {} };

function ledger(routes: Parameters<typeof jsonFetch>[0] = {}) {
  const reports: Report[] = [];
  const mock = jsonFetch({
    "GET /api/extension/status/": () => status,
    "POST /api/extension/report/": (body) => {
      reports.push(body as Report);
      return { applied: 1, conflicts: 0, orders_new: 0, unmatched: [] };
    },
    ...routes,
  });
  return { api: new CardLedgerClient({ baseUrl: BASE, token: "t", fetch: mock.fetch }), reports, calls: mock.calls };
}

function deps(api: CardLedgerClient, extra: Partial<SyncDeps> = {}): SyncDeps {
  let n = 0;
  return {
    api,
    cardtrader: (token) => new CardTraderClient(token, {
      fetch: jsonFetch({
        "GET /api/v2/products/export": () => [],
        "GET /api/v2/orders": () => [],
        "DELETE /api/v2/products/5": () => ({}),
      }).fetch,
      sleep: async () => undefined,
    }),
    cardmarket: async () => {
      throw new Error("no tab");
    },
    cmGames: ["mtg"],
    now: () => NOW,
    uuid: () => `run-${++n}`,
    ...extra,
  };
}

describe("report", () => {
  it("includes stock and orders only when read, and the error when failed", () => {
    const run = startRun("cm", NOW, () => "u1");
    expect(buildReport(run, { results: [] }, null, NOW)).toEqual({
      run_id: "u1", market: "cm", started_at: NOW.toISOString(), finished_at: NOW.toISOString(), results: [],
    });
    const failed = buildReport(run, { results: [{ listing_id: 1, ok: false, error: "x" }], stock: [] }, "boom", NOW);
    expect(failed).toMatchObject({ stock: [], error: "boom" });
    expect(failed).not.toHaveProperty("orders");
    expect(summarize(failed, null, "down")).toMatchObject({ ok: false, changes: 1, published: 0, failed: 1, stock: 0, orders: null, reportError: "down" });
  });

  it("uses a random uuid by default", () => {
    expect(startRun("ct").run_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("runSync", () => {
  it("CardTrader: applies the plan and reports results, stock and orders", async () => {
    const del = change({ action: "delete", market_listing_id: "5" });
    const { api, reports, calls } = ledger({
      "GET /api/extension/cardtrader-token/": () => ({ token: "ct" }),
      "GET /api/extension/plan/?market=ct": () => ({ market: "ct", changes: [del] }),
    });
    const summary = await runSync("ct", deps(api));
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /api/extension/status/", "GET /api/extension/cardtrader-token/", "GET /api/extension/plan/?market=ct", "POST /api/extension/report/",
    ]);
    expect(reports).toEqual([{
      run_id: "run-1", market: "ct", started_at: NOW.toISOString(), finished_at: NOW.toISOString(),
      results: [{ listing_id: del.listing_id, ok: true, market_listing_id: "5" }], stock: [], orders: [],
    }]);
    expect(summary).toMatchObject({ ok: true, run_id: "run-1", published: 1, response: { applied: 1 } });
  });

  it("reports a failed run too, with its error", async () => {
    const { api, reports } = ledger();
    const summary = await runSync("ct", deps(api));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ run_id: "run-1", market: "ct", results: [], error: NO_CT_TOKEN });
    expect(summary).toMatchObject({ ok: false, error: NO_CT_TOKEN });

    const cm = ledger();
    await runSync("cm", deps(cm.api));
    expect(cm.reports[0]).toMatchObject({ market: "cm", error: "no tab" });
  });

  it("keeps what was done when a later step fails", async () => {
    const { api, reports } = ledger({ "GET /api/extension/plan/?market=cm": () => ({ market: "cm", changes: [change({ item: { cm_product_id: null } })] }) });
    const agent: AgentCall = async <T,>(req: { cmd: string }) => {
      if (req.cmd === "whoami") return { username: "Shop" } as T;
      throw new Error("export broke");
    };
    const summary = await runSync("cm", deps(api, { cardmarket: async () => agent }));
    expect(reports[0]!.results).toHaveLength(1);
    expect(reports[0]!.error).toBe("export broke");
    expect(summary.handle).toBe("Shop");
  });

  it("flags a revoked token when the report is refused", async () => {
    const { api } = ledger({ "POST /api/extension/report/": () => [401, { detail: "Invalid token.", code: "authentication_failed" }] });
    const summary = await runSync("cm", deps(api));
    expect(summary).toMatchObject({ ok: false, unauthorized: true, reportError: "Invalid token. — pair the extension again." });
  });
});

describe("runShip", () => {
  it("marks shipped on Cardmarket, then tells CardLedger", async () => {
    const seen: unknown[] = [];
    const agent: AgentCall = async <T,>(req: { cmd: string }) => {
      seen.push(req);
      return (req.cmd === "whoami" ? { username: "Shop" } : undefined) as T;
    };
    const { api, calls } = ledger({ "POST /api/extension/shipped/": () => ({}) });
    await runShip({ market: "cm", market_order_id: "77", tracking_code: " RR1 ", game: "pokemon" }, deps(api, { cardmarket: async () => agent }));
    expect(seen[1]).toEqual({ cmd: "markShipped", game: "pokemon", orderId: "77", trackingCode: " RR1 " });
    expect(calls.at(-1)!.body).toEqual({ market: "cm", market_order_id: "77", tracking_code: "RR1" });
  });
});
