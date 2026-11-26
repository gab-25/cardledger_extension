// Service worker: the only part that talks to CardLedger and to the market tabs (Cardmarket, CardTrader). It reacts to
// messages (popup, CardLedger page bridge) and nothing else: no alarms, no polling, no work on startup besides
// registering the page bridge for the configured CardLedger origin.

import { ApiError, CardLedgerClient } from "./api/cardledger";
import { errorText } from "./lib/util";
import { connectAgent, findCardmarketTab, NO_TAB } from "./markets/cardmarket/tab";
import { connectAgent as connectCtAgent, findCardTraderTab, NO_TAB as NO_CT_TAB } from "./markets/cardtrader/tab";
import type { Request, Response, State } from "./messages";
import { applyBaseUrl, getAuth, getLastRuns, getPendingBaseUrl, getSettings, hostPattern, saveAuth, saveLastRun } from "./storage";
import { runShip, runSync, type SyncDeps } from "./sync";
import type { MarketCode } from "./types";

const BRIDGE_ID = "cardledger-bridge";
let running: MarketCode | null = null;

const NO_URL = "Set the CardLedger URL first (extension popup → Settings).";

async function client(): Promise<CardLedgerClient> {
  const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
  if (!settings.baseUrl) throw new Error(NO_URL);
  return new CardLedgerClient({ baseUrl: settings.baseUrl, token: auth?.token });
}

async function deps(): Promise<SyncDeps> {
  return {
    api: await client(),
    cardtrader: async () => {
      const tab = await findCardTraderTab();
      if (tab?.id === undefined) throw new Error(NO_CT_TAB);
      return connectCtAgent(tab.id);
    },
    cardmarket: async () => {
      const tab = await findCardmarketTab();
      if (tab?.id === undefined) throw new Error(NO_TAB);
      return connectAgent(tab.id);
    },
  };
}

async function forgetIfRevoked(exc: unknown) {
  if (exc instanceof ApiError && exc.unauthorized && exc.code !== "not_paired") await saveAuth(null);
}

async function state(): Promise<State> {
  const [settings, auth, lastRuns] = await Promise.all([getSettings(), getAuth(), getLastRuns()]);
  let status = null;
  let statusError = null;
  if (auth) {
    try {
      status = await (await client()).status();
    } catch (exc) {
      statusError = errorText(exc);
      await forgetIfRevoked(exc);
    }
  }
  const { token: _token, ...publicAuth } = auth ?? { token: "" };
  return {
    paired: !!(await getAuth()),
    auth: auth ? (publicAuth as State["auth"]) : null,
    baseUrl: settings.baseUrl,
    status,
    statusError,
    running,
    lastRuns,
  };
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "state":
      return state();
    case "ping": {
      const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
      return { paired: !!auth, baseUrl: settings.baseUrl, version: chrome.runtime.getManifest().version };
    }
    case "pair": {
      const settings = await getSettings();
      if (!settings.baseUrl) throw new Error(NO_URL);
      const { token, user } = await new CardLedgerClient({ baseUrl: settings.baseUrl }).claim(req.code, req.name);
      await saveAuth({ token, user, pairedAt: new Date().toISOString() });
      return user;
    }
    case "unpair":
      await saveAuth(null);
      return null;
    case "sync": {
      if (!(await getAuth())) throw new Error("Pair the extension with CardLedger first (extension popup).");
      if (running) throw new Error(`A ${running === "cm" ? "Cardmarket" : "CardTrader"} sync is already running.`);
      running = req.market;
      try {
        const summary = await runSync(req.market, await deps());
        await saveLastRun(summary);
        if (summary.unauthorized) await saveAuth(null);
        return summary;
      } finally {
        running = null;
      }
    }
    case "ship": {
      if (!(await getAuth())) throw new Error("Pair the extension with CardLedger first (extension popup).");
      const { type: _type, ...ship } = req;
      try {
        await runShip(ship, await deps());
      } catch (exc) {
        await forgetIfRevoked(exc);
        throw exc;
      }
      return null;
    }
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse: (r: Response) => void) => {
  handle(req).then(
    (value) => sendResponse({ ok: true, value }),
    (exc) => sendResponse({ ok: false, error: errorText(exc) }),
  );
  return true; // async answer
});

/** (Re)register the CardLedger page bridge for the configured origin, if its host permission is granted. */
async function registerBridge() {
  const { baseUrl } = await getSettings();
  await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] }).catch(() => undefined);
  if (!baseUrl) return; // not configured yet
  const pattern = hostPattern(baseUrl);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) return;
  await chrome.scripting.registerContentScripts([
    { id: BRIDGE_ID, matches: [pattern], js: ["content-cardledger.js"], runAt: "document_start", persistAcrossSessions: true },
  ]);
}

chrome.runtime.onInstalled.addListener(() => void registerBridge());
chrome.runtime.onStartup.addListener(() => void registerBridge());
// A CardLedger URL saved in the popup's settings waits for its host permission: the popup closes while Chrome asks,
// so it is applied here once granted.
chrome.permissions.onAdded.addListener((added) => {
  void (async () => {
    const pending = await getPendingBaseUrl();
    if (pending && added.origins?.includes(hostPattern(pending))) await applyBaseUrl(pending);
    await registerBridge();
  })();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void registerBridge();
});
