// Content script on the CardLedger origin: a window.postMessage bridge so the CardLedger UI can detect the extension
// and ask it to sync. Protocol (all messages carry an optional `id` echoed in the answer):
//
//   page -> extension                                         extension -> page
//   {type: "cardledger:ping", id?}                            {type: "cardledger:pong", id, version, paired}
//   {type: "cardledger:sync", id?, market: "cm"|"ct"}         {type: "cardledger:sync-result", id, market, ok,
//                                                               run?: RunSummary, error?}
//   {type: "cardledger:ship", id?, market, market_order_id,   {type: "cardledger:ship-result", id, market,
//      tracking_code?, game?}                                    market_order_id, ok, error?}
//
// Only messages from the page itself (same window, same origin) are answered, and only when the page's origin is the
// CardLedger URL set in the extension's settings. The UI treats "no pong within 1 s" as "extension not installed".

import type { Ping, Request } from "../messages";
import type { RunSummary } from "../report";
import { MARKETS, type MarketCode } from "../types";

export interface BridgeDeps {
  win: Window;
  /** chrome.runtime.sendMessage wrapped: resolves to the value, rejects with the error. */
  send: <T>(req: Request) => Promise<T>;
}

type Incoming = {
  type?: unknown;
  id?: unknown;
  market?: unknown;
  market_order_id?: unknown;
  tracking_code?: unknown;
  game?: unknown;
};

const isMarket = (m: unknown): m is MarketCode => typeof m === "string" && (MARKETS as readonly string[]).includes(m);
const errorText = (exc: unknown) => (exc instanceof Error ? exc.message : String(exc));

export function installBridge({ win, send }: BridgeDeps): () => void {
  const origin = win.location.origin;
  const reply = (msg: Record<string, unknown>) => win.postMessage(msg, origin);

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== win || event.origin !== origin) return;
    const data = event.data as Incoming | null;
    if (!data || typeof data.type !== "string" || !data.type.startsWith("cardledger:")) return;
    const id = data.id ?? null;
    if (!["cardledger:ping", "cardledger:sync", "cardledger:ship"].includes(data.type)) return;

    let ping: Ping;
    try {
      ping = await send<Ping>({ type: "ping" });
    } catch {
      return; // extension reloading: stay silent, the page will think it's absent
    }
    if (new URL(ping.baseUrl).origin !== origin) return; // not the configured CardLedger

    if (data.type === "cardledger:ping") {
      reply({ type: "cardledger:pong", id, version: ping.version, paired: ping.paired });
      return;
    }
    if (data.type === "cardledger:sync") {
      const market = data.market;
      if (!isMarket(market)) {
        reply({ type: "cardledger:sync-result", id, market, ok: false, error: `Unknown market: ${String(market)}` });
        return;
      }
      try {
        const run = await send<RunSummary>({ type: "sync", market });
        reply({ type: "cardledger:sync-result", id, market, ok: run.ok, run, ...(run.ok ? {} : { error: run.error ?? run.reportError }) });
      } catch (exc) {
        reply({ type: "cardledger:sync-result", id, market, ok: false, error: errorText(exc) });
      }
      return;
    }
    // cardledger:ship
    const market = data.market;
    const orderId = data.market_order_id;
    const base = { type: "cardledger:ship-result", id, market, market_order_id: orderId };
    if (!isMarket(market) || (typeof orderId !== "string" && typeof orderId !== "number")) {
      reply({ ...base, ok: false, error: "market and market_order_id are required" });
      return;
    }
    try {
      await send({
        type: "ship",
        market,
        market_order_id: String(orderId),
        tracking_code: typeof data.tracking_code === "string" ? data.tracking_code : "",
        ...(typeof data.game === "string" ? { game: data.game } : {}),
      });
      reply({ ...base, ok: true });
    } catch (exc) {
      reply({ ...base, ok: false, error: errorText(exc) });
    }
  };

  const listener = (event: MessageEvent) => void onMessage(event);
  win.addEventListener("message", listener);
  return () => win.removeEventListener("message", listener);
}

declare global {
  interface Window {
    __cardledgerBridge?: boolean;
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof window !== "undefined" && !window.__cardledgerBridge) {
  window.__cardledgerBridge = true;
  installBridge({
    win: window,
    send: async <T,>(req: Request): Promise<T> => {
      const resp = (await chrome.runtime.sendMessage(req)) as { ok: true; value: T } | { ok: false; error: string } | undefined;
      if (!resp) throw new Error("The extension did not answer.");
      if (!resp.ok) throw new Error(resp.error);
      return resp.value;
    },
  });
}
