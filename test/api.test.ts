import { describe, expect, it } from "vitest";
import { ApiError, CardLedgerClient, normalizeBaseUrl } from "../src/api/cardledger";
import type { Report } from "../src/types";
import { jsonFetch } from "./helpers";

const BASE = "https://ledger.example.com";

describe("CardLedgerClient", () => {
  it("claims a pairing code without a token", async () => {
    const { fetch, calls } = jsonFetch({
      "POST /api/extension/claim/": () => ({ token: "raw-token", user: { username: "gab", full_name: "Gab" } }),
    });
    const client = new CardLedgerClient({ baseUrl: `${BASE}/`, fetch });
    const out = await client.claim(" abcd-1234 ", "Chrome");
    expect(out.token).toBe("raw-token");
    expect(calls[0]!.body).toEqual({ code: "ABCD-1234", name: "Chrome" });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("sends the token on extension calls", async () => {
    const { fetch, calls } = jsonFetch({
      "GET /api/extension/status/": () => ({ user: { username: "gab", full_name: "" }, markets: [], pending: { cm: 2 } }),
      "GET /api/extension/plan/?market=cm": () => ({ market: "cm", changes: [] }),
    });
    const client = new CardLedgerClient({ baseUrl: BASE, token: "t0k", fetch });
    expect((await client.status()).pending.cm).toBe(2);
    expect((await client.plan("cm")).market).toBe("cm");
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Token t0k", "Token t0k"]);
    expect(calls[1]!.url.toString()).toBe(`${BASE}/api/extension/plan/?market=cm`);
  });

  it("posts reports and shipped notices as JSON", async () => {
    const { fetch, calls } = jsonFetch({
      "POST /api/extension/report/": () => ({ applied: 1, conflicts: 0, orders_new: 0, unmatched: [] }),
      "POST /api/extension/shipped/": () => ({}),
    });
    const client = new CardLedgerClient({ baseUrl: BASE, token: "t", fetch });
    const report: Report = { run_id: "r1", market: "ct", started_at: "a", finished_at: "b", results: [{ listing_id: 4, ok: true, market_listing_id: "9" }] };
    expect((await client.report(report)).applied).toBe(1);
    await client.shipped({ market: "cm", market_order_id: "11", tracking_code: "RR1" });
    expect(calls[0]!.body).toEqual(report);
    expect(calls[1]!.body).toEqual({ market: "cm", market_order_id: "11", tracking_code: "RR1" });
  });

  it("turns API errors into ApiError with code and fields", async () => {
    const { fetch } = jsonFetch({
      "POST /api/extension/claim/": () => [400, { code: ["This code expired."] }],
      "GET /api/extension/status/": () => [401, { detail: "Invalid token.", code: "authentication_failed" }],
    });
    const client = new CardLedgerClient({ baseUrl: BASE, token: "t", fetch });
    const claim = await client.claim("x", "y").catch((e) => e);
    expect(claim).toBeInstanceOf(ApiError);
    expect(claim.message).toBe("code: This code expired.");
    expect(claim.fields).toEqual({ code: ["This code expired."] });
    const status = await client.status().catch((e) => e);
    expect(status.code).toBe("authentication_failed");
    expect(status.unauthorized).toBe(true);
  });

  it("refuses authenticated calls before pairing, and reports an unreachable server", async () => {
    const client = new CardLedgerClient({ baseUrl: BASE, fetch: jsonFetch({}).fetch });
    await expect(client.status()).rejects.toMatchObject({ code: "not_paired" });
    const down = new CardLedgerClient({ baseUrl: BASE, token: "t", fetch: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch });
    await expect(down.status()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("normalises the base URL", () => {
    expect(normalizeBaseUrl(" http://localhost:5173/ ")).toBe("http://localhost:5173");
    expect(normalizeBaseUrl("https://x.example/ledger//")).toBe("https://x.example/ledger");
  });
});
