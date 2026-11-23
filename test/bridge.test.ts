import { afterEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "../src/content/cardledger";
import type { Request } from "../src/messages";

type Answer = Record<string, unknown>;

function setup(send: (req: Request) => Promise<unknown>, baseUrl = window.location.origin) {
  const answers: Answer[] = [];
  const onAnswer = (e: MessageEvent) => {
    if (typeof e.data?.type === "string" && /pong|result/.test(e.data.type)) answers.push(e.data);
  };
  window.addEventListener("message", onAnswer);
  const sent: Request[] = [];
  const uninstall = installBridge({
    win: window,
    send: (async (req: Request) => {
      sent.push(req);
      if (req.type === "ping") return { paired: true, baseUrl, version: "0.1.0" };
      return send(req);
    }) as <T>(req: Request) => Promise<T>,
  });
  cleanups.push(() => {
    uninstall();
    window.removeEventListener("message", onAnswer);
  });
  const post = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: window, origin: window.location.origin }));
  return { answers, sent, post };
}

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("CardLedger page bridge", () => {
  it("answers a ping with the version and pairing state", async () => {
    const { answers, post } = setup(async () => null);
    post({ type: "cardledger:ping", id: 7 });
    await vi.waitFor(() => expect(answers).toEqual([{ type: "cardledger:pong", id: 7, version: "0.1.0", paired: true }]));
  });

  it("runs a sync and answers with its summary", async () => {
    const run = { ok: true, run_id: "r1", market: "cm" };
    const { answers, sent, post } = setup(async () => run);
    post({ type: "cardledger:sync", id: "a", market: "cm" });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(sent.at(-1)).toEqual({ type: "sync", market: "cm" });
    expect(answers[0]).toEqual({ type: "cardledger:sync-result", id: "a", market: "cm", ok: true, run });
  });

  it("answers failures with the error", async () => {
    const { answers, post } = setup(async (req) => {
      if (req.type === "sync") return { ok: false, run_id: "r2", error: "Not logged in" };
      throw new Error("tab closed");
    });
    post({ type: "cardledger:sync", market: "ct" });
    post({ type: "cardledger:sync", market: "ebay" });
    post({ type: "cardledger:ship", market: "cm", market_order_id: 12, tracking_code: "RR" });
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    expect(answers).toContainEqual(expect.objectContaining({ type: "cardledger:sync-result", market: "ct", ok: false, error: "Not logged in" }));
    expect(answers).toContainEqual(expect.objectContaining({ type: "cardledger:sync-result", market: "ebay", ok: false, error: "Unknown market: ebay" }));
    expect(answers).toContainEqual({ type: "cardledger:ship-result", id: null, market: "cm", market_order_id: 12, ok: false, error: "tab closed" });
  });

  it("ignores other windows, other message types and pages that aren't the configured CardLedger", async () => {
    const { answers, sent, post } = setup(async () => null);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "cardledger:ping" }, source: null, origin: window.location.origin }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "cardledger:ping" }, source: window, origin: "https://evil.example" }));
    post({ type: "something:else" });
    post({ type: "cardledger:unknown" });
    await settle();
    expect(sent).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it("stays silent on a page that isn't the configured CardLedger", async () => {
    const other = setup(async () => null, "https://ledger.example.com");
    other.post({ type: "cardledger:sync", market: "cm" });
    await settle();
    expect(other.sent.map((s) => s.type)).toEqual(["ping"]);
    expect(other.answers).toHaveLength(0);
  });
});
