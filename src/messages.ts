// Messages to the background service worker (chrome.runtime.sendMessage), from the popup and the
// CardLedger page bridge.

import type { Auth } from "./storage";
import type { RunSummary } from "./report";
import type { MarketCode, StatusResponse } from "./types";
import type { ShipRequest } from "./sync";

export type Request =
  | { type: "sync"; market: MarketCode }
  | { type: "ship" } & ShipRequest
  | { type: "pair"; code: string; name: string }
  | { type: "unpair" }
  | { type: "state" }
  | { type: "ping" };

export interface Ping {
  paired: boolean;
  baseUrl: string;
  version: string;
}

export interface State {
  paired: boolean;
  auth: Omit<Auth, "token"> | null;
  baseUrl: string;
  status: StatusResponse | null;
  statusError: string | null;
  running: MarketCode | null;
  lastRuns: Partial<Record<MarketCode, RunSummary>>;
}

export type Response<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export async function send<T>(req: Request): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!resp) throw new Error("The extension did not answer.");
  if (!resp.ok) throw new Error(resp.error);
  return resp.value;
}
