// Popup: pairing, status per market, the Sync buttons and the last run of each market.

import { send, type State } from "../messages";
import type { RunSummary } from "../report";
import { MARKETS, MARKET_NAMES, type MarketCode } from "../types";
import { h, when } from "../ui/dom";

const app = document.getElementById("app")!;
let busy: MarketCode | null = null;
let message: { text: string; tone: "ok" | "err" } | null = null;

function runView(run: RunSummary | undefined) {
  if (!run) return h("p", { class: "muted small" }, "No sync yet from this browser.");
  const parts = [
    `${run.published}/${run.changes} changes applied`,
    run.stock !== null ? `${run.stock} listings read` : null,
    run.orders !== null ? `${run.orders} orders read` : null,
  ].filter(Boolean);
  const r = run.response;
  return h(
    "div",
    { class: "small" },
    h("p", {}, h("span", { class: run.ok ? "ok" : "err" }, run.ok ? "Last sync OK" : "Last sync failed"), ` · ${when(run.finished_at)}`),
    h("p", { class: "muted" }, parts.join(" · ")),
    r ? h("p", { class: "muted" }, `CardLedger: ${r.applied} applied, ${r.conflicts} conflicts, ${r.orders_new} new orders, ${r.unmatched.length} unmatched`) : null,
    run.error ? h("p", { class: "err" }, run.error) : null,
    run.reportError ? h("p", { class: "err" }, `Report not delivered: ${run.reportError}`) : null,
    run.failures.length
      ? h("ul", { class: "err" }, ...run.failures.map((f) => h("li", {}, `Listing ${f.listing_id}: ${f.error ?? "failed"}`)))
      : null,
  );
}

function marketCard(state: State, code: MarketCode) {
  const m = state.status?.markets.find((x) => x.code === code);
  const pending = state.status?.pending?.[code] ?? 0;
  const disabled = !!busy || !!state.running;
  const label = busy === code || state.running === code ? "Syncing…" : `Sync ${MARKET_NAMES[code]}`;
  return h(
    "div",
    { class: "card" },
    h("div", { class: "row" },
      h("h2", {}, MARKET_NAMES[code]),
      h("span", { class: `small ${m?.status === "ok" ? "ok" : m?.status === "error" ? "err" : "muted"}` },
        m ? (m.connected ? `${m.status}${m.handle ? ` · ${m.handle}` : ""}` : "not connected") : ""),
    ),
    h("p", { class: "muted small" }, `Last sync ${when(m?.last_sync)} · ${pending} change${pending === 1 ? "" : "s"} to push`),
    h("p", {}, h("button", { class: "primary", disabled, onclick: () => void sync(code) }, label)),
    runView(state.lastRuns[code]),
  );
}

function pairView(state: State) {
  const code = h("input", { type: "text", id: "code", placeholder: "ABCD-1234", autocomplete: "off" });
  const form = h(
    "form",
    { class: "card" },
    h("p", {}, "Pair this browser with CardLedger: open ", h("b", {}, "Account → Browser extension"), " in CardLedger, create a pairing code and enter it here."),
    h("label", { for: "code" }, "Pairing code"),
    code,
    h("p", {}),
    h("button", { class: "primary", type: "submit" }, "Pair"),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void pair(code.value);
  });
  return h("div", {}, form, h("p", { class: "muted small" }, `CardLedger: ${state.baseUrl} · `,
    h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); } }, "change")));
}

function render(state: State) {
  app.replaceChildren();
  if (message) app.append(h("p", { class: message.tone }, message.text));
  if (!state.paired) {
    app.append(pairView(state));
    return;
  }
  const user = state.status?.user ?? state.auth?.user;
  app.append(
    h("p", { class: "small" }, `Signed in as `, h("b", {}, user?.full_name || user?.username || "?"), ` on ${new URL(state.baseUrl).host}`),
    state.statusError ? h("p", { class: "err small" }, state.statusError) : "",
    ...MARKETS.map((code) => marketCard(state, code)),
    h("p", { class: "muted small" }, "Cardmarket and CardTrader sync through your open cardmarket.com / cardtrader.com tabs (be logged in there)."),
    h("div", { class: "gap" },
      h("button", { onclick: () => void chrome.tabs.create({ url: "https://www.cardmarket.com/" }) }, "Open Cardmarket"),
      h("button", { onclick: () => void chrome.tabs.create({ url: "https://www.cardtrader.com/" }) }, "Open CardTrader"),
      h("button", { onclick: () => void chrome.runtime.openOptionsPage() }, "Options"),
      h("button", { onclick: () => void unpair() }, "Unpair"),
    ),
  );
}

async function refresh() {
  try {
    render(await send<State>({ type: "state" }));
  } catch (exc) {
    app.replaceChildren(h("p", { class: "err" }, (exc as Error).message));
  }
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
  message = null;
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

void refresh();
