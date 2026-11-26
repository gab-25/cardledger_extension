// Popup, as the "Browser extension · popup" mockups of the CardLedger Pro design canvas: a header (settings), which
// tab you are on, one card per market (only the market of the active tab can sync), and two panels of their own:
// Settings (the CardLedger URL, unpairing) and pairing.

import { normalizeBaseUrl } from "../api/cardledger";
import { MARKET_ORIGINS, marketOfUrl } from "../markets/hosts";
import { send, type State } from "../messages";
import type { RunSummary } from "../report";
import { MARKETS, MARKET_NAMES, type MarketCode } from "../types";
import { applyBaseUrl, hostPattern, setPendingBaseUrl } from "../storage";
import { h, when } from "../ui/dom";
import markUrl from "../icons/icon.svg";

const app = document.getElementById("app")!;
const version = chrome.runtime.getManifest().version;
let busy: MarketCode | null = null;
let message: { text: string; tone: "ok" | "err" } | null = null;
let view: "main" | "settings" = "main";
/** The market whose site is the active tab: only its Sync button is enabled. */
let activeMarket: MarketCode | null = null;

/** The URL of a market tab is visible thanks to the host permissions (other tabs' URLs are hidden: null). */
async function readActiveMarket(): Promise<MarketCode | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return marketOfUrl(tab?.url);
  } catch {
    return null;
  }
}

// --- icons (inline SVG, built as DOM: nothing parsed as HTML) ------------------------------------------------------

const GEAR = [
  "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
];
const BACK = ["M15 18l-6-6 6-6"];
const SYNC = ["M21 12a9 9 0 0 1-15.5 6.2L3 16", "M3 12a9 9 0 0 1 15.5-6.2L21 8", "M21 3v5h-5", "M3 21v-5h5"];
const ALERT = ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 8v5", "M12 16.5v.01"];

function icon(paths: string[], size = 18): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const attrs: Record<string, string> = {
    width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// --- pieces ---------------------------------------------------------------------------------------------------------

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const openMarket = (code: MarketCode) => void chrome.tabs.create({ url: `${MARKET_ORIGINS[code]}/` });

function topBar(state: State, withUser: boolean) {
  const user = state.status?.user ?? state.auth?.user;
  return h(
    "header",
    { class: "bar top" },
    h("img", { src: markUrl, width: "24", height: "24", alt: "" }),
    h("span", { class: "title" },
      h("b", {}, "CardLedger Sync"),
      withUser ? h("span", {}, `${user?.username || "?"} · ${host(state.baseUrl)}`) : null),
    h("button", { class: "icon", "aria-label": "Settings", title: "Settings", onclick: () => show("settings") }, icon(GEAR)),
  );
}

function bottomBar(...left: Array<Node | string>) {
  return h("footer", { class: "bar bottom" }, h("span", { class: "grow ellipsis" }, ...left), h("span", { class: "mono" }, `v${version}`));
}

function flash() {
  return message ? h("div", { class: `banner ${message.tone}`, role: message.tone === "err" ? "alert" : "status" }, message.text) : null;
}

// --- main view ------------------------------------------------------------------------------------------------------

function tabBanner(state: State) {
  if (activeMarket) {
    const handle = state.status?.markets.find((m) => m.code === activeMarket)?.handle || state.lastRuns[activeMarket]?.handle;
    return h("div", { class: "banner ok" },
      h("span", { class: "dot", "aria-hidden": "true" }),
      handle
        ? h("span", {}, `This tab is ${MARKET_NAMES[activeMarket]} · `, h("b", {}, handle))
        : h("span", {}, `This tab is ${MARKET_NAMES[activeMarket]}`));
  }
  return h("div", { class: "banner info" },
    h("b", {}, "Sync runs in the market's own tab"),
    h("span", {}, "Open Cardmarket or CardTrader, log in there, then open this popup again."),
    h("div", { class: "row" }, ...MARKETS.map((code) => h("button", { class: "open", onclick: () => openMarket(code) }, `Open ${MARKET_NAMES[code]}`))));
}

function runAlert(run: RunSummary) {
  const lines = [run.error, run.reportError ? `Report not delivered: ${run.reportError}` : null].filter(Boolean) as string[];
  if (!lines.length && !run.failures.length) return null;
  return h("div", { class: "alert", role: "alert" },
    icon(ALERT, 16),
    h("div", {},
      ...lines.map((l) => h("p", {}, l)),
      run.failures.length
        ? h("ul", {}, ...run.failures.map((f) => h("li", {}, `Listing ${f.listing_id}: ${f.error ?? "failed"}`)))
        : null));
}

function runSummary(run: RunSummary | undefined) {
  if (!run) return h("div", { class: "run" }, h("span", {}, "No sync yet from this browser."));
  const read = [
    run.stock !== null ? plural(run.stock, "listing") + " read" : null,
    run.orders !== null ? plural(run.orders, "order") + " read" : null,
    run.response?.orders_new ? plural(run.response.orders_new, "new order") + " in CardLedger" : null,
    run.response?.conflicts ? plural(run.response.conflicts, "conflict") : null,
  ].filter(Boolean);
  return h("div", { class: "run" },
    h("span", {},
      h("span", { class: run.ok ? "good" : "bad" }, run.ok ? "Last sync OK" : "Last sync failed"),
      ` · ${run.published}/${run.changes} changes applied · ${when(run.finished_at)}`),
    read.length ? h("span", {}, read.join(" · ")) : null);
}

function marketCard(state: State, code: MarketCode) {
  const m = state.status?.markets.find((x) => x.code === code);
  const pending = state.status?.pending?.[code] ?? 0;
  const run = state.lastRuns[code];
  const here = activeMarket === code;
  const syncing = busy === code || state.running === code;
  const [chip, tone] = !m?.connected ? ["Not connected", ""] : m.status === "error" ? ["Error", "err"] : ["Connected", "ok"];
  const button = h("button", {
    class: "primary wide", disabled: !here || !!busy || !!state.running, onclick: () => void sync(code),
  }, icon(SYNC, 16), syncing ? "Syncing…" : `Sync ${MARKET_NAMES[code]}`);
  const head = h("div", { class: "card-head" },
    h("span", { class: `badge ${code}` }, code.toUpperCase()),
    h("h2", {}, MARKET_NAMES[code]),
    h("span", { class: `chip ${tone}` }, chip));
  if (here) {
    return h("section", { class: "card here", "aria-label": MARKET_NAMES[code] },
      head,
      h("div", { class: "stats" },
        h("span", { class: "stat" }, h("span", {}, "To push"), h("span", { class: "big" }, plural(pending, "change"))),
        h("span", { class: "stat" }, h("span", {}, "Last sync"), h("span", {}, when(m?.last_sync)))),
      button,
      run ? runAlert(run) : null,
      runSummary(run));
  }
  return h("section", { class: "card", "aria-label": MARKET_NAMES[code] },
    head,
    h("span", { class: "line" },
      `${plural(pending, "change")} to push · last sync ${when(m?.last_sync)}`,
      run ? h("span", { class: run.ok ? "good" : "bad" }, run.ok ? " OK" : " failed") : null),
    run && !run.ok ? runAlert(run) : null,
    button,
    activeMarket
      ? h("span", { class: "hint" }, `Sync it from a ${MARKET_NAMES[code]} tab. `,
          h("button", { class: "link", onclick: () => openMarket(code) }, `Open ${MARKET_NAMES[code]}`))
      : null);
}

function mainView(state: State) {
  return [
    topBar(state, true),
    h("div", { class: "body" },
      flash(),
      state.statusError ? h("div", { class: "banner err", role: "alert" }, state.statusError) : null,
      tabBanner(state),
      ...MARKETS.map((code) => marketCard(state, code))),
    bottomBar("Pages read at a human pace, only when you press Sync."),
  ];
}

// --- pairing --------------------------------------------------------------------------------------------------------

function pairView(state: State) {
  const code = h("input", { type: "text", id: "code", class: "code", placeholder: "ABCD-1234", autocomplete: "off", required: true });
  const form = h("form", { class: "panel", "aria-label": "Pairing" },
    h("label", { for: "code" }, "Pairing code"),
    code,
    h("button", { class: "primary wide", type: "submit" }, "Pair"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void pair(code.value);
  });
  const step = (n: number, ...text: Array<Node | string>) => h("li", {}, h("span", { class: "n" }, String(n)), h("span", {}, ...text));
  return [
    topBar(state, false),
    h("div", { class: "body" },
      flash(),
      h("div", { class: "intro" },
        h("h1", {}, "Pair this browser"),
        h("p", { class: "note" }, "Connect the extension to your CardLedger once; it then syncs Cardmarket and CardTrader from their tabs.")),
      h("ol", { class: "steps" },
        step(1, "In CardLedger, open ", h("b", {}, "Account → Browser extension"), "."),
        step(2, "Create a pairing code (valid 10 minutes)."),
        step(3, "Enter it here.")),
      form),
    h("footer", { class: "bar bottom" },
      h("span", { class: "grow ellipsis" }, "CardLedger: ", h("span", { class: "mono" }, host(state.baseUrl))),
      h("button", { class: "link", onclick: () => show("settings") }, "Change")),
  ];
}

// --- settings -------------------------------------------------------------------------------------------------------

function settingsView(state: State) {
  const url = h("input", { type: "url", id: "url", required: true, value: state.baseUrl, placeholder: "https://ledger.example.com" });
  const form = h("form", { class: "panel", "aria-label": "CardLedger address" },
    h("label", { for: "url" }, "CardLedger URL"),
    url,
    h("p", { class: "note" }, "The address you open CardLedger at. A new address asks Chrome for permission to reach it, and changing it unpairs this browser."),
    h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Save")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void saveUrl(url.value, state.baseUrl);
  });
  const user = state.status?.user ?? state.auth?.user;
  const name = user?.username || "?";
  const since = state.auth?.pairedAt ? ` · since ${new Date(state.auth.pairedAt).toLocaleDateString()}` : "";
  return [
    h("header", { class: "bar top" },
      h("button", { class: "icon ink", "aria-label": "Back", title: "Back", onclick: () => show("main") }, icon(BACK)),
      h("span", { class: "title" }, h("h1", {}, "Settings"))),
    h("div", { class: "body" },
      flash(),
      form,
      state.paired
        ? h("section", { class: "panel", "aria-label": "This browser" },
            h("h2", {}, "This browser"),
            h("div", { class: "who" },
              h("span", { class: "avatar", "aria-hidden": "true" }, name.slice(0, 1).toUpperCase()),
              h("span", {}, h("b", {}, `Paired as ${user?.full_name || name}`), h("span", { class: "ellipsis" }, `${host(state.baseUrl)}${since}`))),
            h("button", { class: "danger", onclick: () => void unpair() }, "Unpair"),
            h("p", { class: "note" }, "Forgets this browser's token. Revoke it from CardLedger too, in Account → Browser extension."))
        : null),
    bottomBar("CardLedger Sync"),
  ];
}

// --- render and actions ---------------------------------------------------------------------------------------------

function render(state: State) {
  const parts = view === "settings" ? settingsView(state) : state.paired ? mainView(state) : pairView(state);
  app.replaceChildren(...parts);
}

function show(next: typeof view) {
  view = next;
  message = null;
  void refresh();
}

async function refresh() {
  try {
    render(await send<State>({ type: "state" }));
  } catch (exc) {
    app.replaceChildren(h("div", { class: "body" }, h("div", { class: "banner err", role: "alert" }, (exc as Error).message)));
  }
}

/**
 * Save the CardLedger URL. Chrome's permission prompt must open within the click (nothing awaited before it) and it
 * closes the popup: the URL is left pending and the background applies it when the permission is granted.
 */
async function saveUrl(raw: string, current: string) {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(raw);
  } catch {
    message = { text: "Not a valid URL.", tone: "err" };
    await refresh();
    return;
  }
  const asked = chrome.permissions.request({ origins: [hostPattern(baseUrl)] });
  void setPendingBaseUrl(baseUrl);
  if (!(await asked)) {
    message = { text: "Permission refused: the extension can't reach this URL.", tone: "err" };
    await refresh();
    return;
  }
  await applyBaseUrl(baseUrl);
  view = "main";
  message = baseUrl === current ? { text: "Saved.", tone: "ok" } : { text: "Saved. Pair again with this CardLedger.", tone: "ok" };
  await refresh();
}

async function pair(code: string) {
  try {
    await send({ type: "pair", code, name: `Chrome on ${navigator.platform || "this computer"}` });
    message = { text: "Paired with CardLedger.", tone: "ok" };
  } catch (exc) {
    message = { text: (exc as Error).message, tone: "err" };
  }
  await refresh();
}

async function unpair() {
  await send({ type: "unpair" });
  view = "main";
  message = { text: "Unpaired.", tone: "ok" };
  await refresh();
}

async function sync(market: MarketCode) {
  busy = market;
  message = null;
  await refresh();
  try {
    const run = await send<RunSummary>({ type: "sync", market });
    message = run.ok ? { text: `${MARKET_NAMES[market]} synced.`, tone: "ok" } : { text: `${MARKET_NAMES[market]} sync failed.`, tone: "err" };
  } catch (exc) {
    message = { text: (exc as Error).message, tone: "err" };
  } finally {
    busy = null;
  }
  await refresh();
}

void readActiveMarket().then((market) => {
  activeMarket = market;
  void refresh();
});
