// Everything the extension keeps, in chrome.storage.local: the CardLedger URL, the pairing token (never Cardmarket
// credentials: Cardmarket is used through the browser's own session) and the last run of each market.

import type { MarketCode, User } from "./types";
import type { RunSummary } from "./report";

export interface Settings {
  /** The CardLedger URL, set by the user in the popup's Settings: "" until then (there is no built-in default). */
  baseUrl: string;
}

export interface Auth {
  token: string;
  user: User;
  pairedAt: string;
}

export interface Stored {
  settings?: Partial<Settings>;
  /** A CardLedger URL waiting for its host permission (the popup closes while Chrome asks for it). */
  pendingBaseUrl?: string;
  auth?: Auth;
  lastRuns?: Partial<Record<MarketCode, RunSummary>>;
}

export const DEFAULT_SETTINGS: Settings = { baseUrl: "" };

async function get<K extends keyof Stored>(key: K): Promise<Stored[K]> {
  const data = (await chrome.storage.local.get(key)) as Stored;
  return data[key];
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await get("settings")) ?? {}) };
}

export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...settings };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/**
 * Make baseUrl the CardLedger URL. The token belongs to the previous CardLedger: a change unpairs.
 * Returns whether the URL changed.
 */
export async function applyBaseUrl(baseUrl: string): Promise<boolean> {
  const before = await getSettings();
  await saveSettings({ baseUrl });
  await chrome.storage.local.remove("pendingBaseUrl");
  if (before.baseUrl === baseUrl) return false;
  await saveAuth(null);
  return true;
}

export async function setPendingBaseUrl(baseUrl: string): Promise<void> {
  await chrome.storage.local.set({ pendingBaseUrl: baseUrl });
}

export async function getPendingBaseUrl(): Promise<string | null> {
  return (await get("pendingBaseUrl")) ?? null;
}

export async function getAuth(): Promise<Auth | null> {
  return (await get("auth")) ?? null;
}

export async function saveAuth(auth: Auth | null): Promise<void> {
  if (auth) await chrome.storage.local.set({ auth });
  else await chrome.storage.local.remove("auth");
}

export async function getLastRuns(): Promise<Partial<Record<MarketCode, RunSummary>>> {
  return (await get("lastRuns")) ?? {};
}

export async function saveLastRun(run: RunSummary): Promise<void> {
  const runs = await getLastRuns();
  runs[run.market] = run;
  await chrome.storage.local.set({ lastRuns: runs });
}

/** Host permission pattern of a URL's host, any port: "http://localhost:5173/x" -> "http://localhost/*". */
export function hostPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
