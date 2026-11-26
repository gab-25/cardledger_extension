# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome MV3 extension that syncs CardLedger (backend: sibling repo cardledger_core, Django; UI: cardledger_ui) with
Cardmarket ("cm") and CardTrader ("ct"). The server never talks to the markets: the extension fetches a plan from
CardLedger, applies it on the market inside the user's own logged-in tab (Cardmarket: "My Offers" pages, sell form, edit
modal and +/- AJAX actions — a private account has no stock CSV; CardTrader: "My items" JSON, "Sell via spreadsheet"
import, the edit panel's JSON PATCH/DELETE; both: orders pages, ship on the order page), and posts back a report. There is no CardTrader API token
anywhere in the system. The CardLedger side of the
contract is `/api/extension/*` (token auth `Authorization: Token <token>`, obtained by pairing); its types are in
`src/types.ts`.

## Commands

```bash
npm test                                          # Vitest (jsdom), all tests
npx vitest run test/cardtrader.test.ts            # one file
npx vitest run test/cardtrader.test.ts -t "tag"   # one test by name
npm run typecheck                                 # tsc --noEmit (strict)
npm run build                                     # tsc + scripts/build.mjs -> dist/ (load unpacked)
VITE_CARDLEDGER_URL=https://… npm run build       # default CardLedger URL (else http://localhost:5173)
```

## Rules (product decisions, don't break them)

- **User-initiated only**: no `alarms`, no timers, no work at startup besides registering the page bridge.
- **Human pace**: requests are sequential; market pages ≥ `MIN_REQUEST_GAP_MS` (1.5 s) apart, enforced in each agent
  (`Pacer` in `src/lib/forms.ts`).
- **No market credentials**: both markets are driven inside the user's own tab with its session cookies; the
  extension never reads cookies or passwords and uses no market API token. Only the CardLedger token (and settings,
  last runs) go in `chrome.storage.local`.
- **One report per run**, with a fresh uuid `run_id`, even on failure (`error` + whatever was done before).
- Host permissions: www.cardmarket.com, www.cardtrader.com, localhost/127.0.0.1, the build's default URL; any other
  CardLedger origin is requested at runtime from the popup's Settings (`optional_host_permissions`; the popup closes
  while Chrome asks, so the URL waits as `pendingBaseUrl` and the background applies it on `permissions.onAdded`).

## Architecture

- `src/background.ts`: service worker; handles `chrome.runtime` messages (`src/messages.ts`: `sync`, `ship`, `pair`,
  `unpair`, `state`, `ping`), one sync at a time; registers the page bridge for the configured origin
  (`chrome.scripting.registerContentScripts`).
- `src/sync.ts`: `runSync(market, deps)` (plan → adapter → report, always reporting) and `runShip`. Dependencies are
  injected (`SyncDeps`) so tests mock CardLedger and the two market agents.
- `src/report.ts`: report building and the `RunSummary` shown in the popup / sent to the page.
- `src/api/cardledger.ts`: typed client of `/api/extension/*`; errors → `ApiError` (`code`, `fields`, `unauthorized`).
- `src/markets/cardmarket/`:
  - **`format.ts` — the formats module**: every Cardmarket URL, selector, form field, code mapping, label and
    date/money format. Nothing about Cardmarket's formats may live elsewhere. Blocks are `VERIFIED (date)` (real
    fixture) or `ASSUMPTION` (README, "Finalising the Cardmarket formats"); when correcting one, replace the fixture in
    `test/fixtures/cardmarket/` with the real (redacted) page first — as the server sends it (`fetch`), not as
    rendered — then fix until tests pass.
  - `agent.ts`: runs in the cardmarket.com tab (built as IIFE, injected with `chrome.scripting.executeScript`,
    exposes `window.__cardledgerAgent.handle(request)`); does the page work (paced fetch, DOMParser, form posts).
    Service workers have no DOMParser: all HTML parsing happens here.
  - `plan.ts`: pure: splits the plan per game, verifies each change by diffing the stock ("My Offers") read
    before/after the page actions.
  - `adapter.ts`: background-side orchestration over an `AgentCall`; `tab.ts` finds the tab and injects the agent.
- `src/markets/cardtrader/`: the same layout as Cardmarket, for a www.cardtrader.com tab.
  - **`format.ts` — the formats module**: every CardTrader URL, JSON shape, import column, code mapping, game id,
    selector and label. `VERIFIED (date)` / `ASSUMPTION` blocks as for Cardmarket (README, "Finalising the
    CardTrader formats"); fixtures in `test/fixtures/cardtrader/` (real ones: redacted answers).
  - `agent.ts`: IIFE content script, `window.__cardledgerCtAgent.handle(request)`; Rails-style forms
    (`authenticity_token`, `_method`) and, for JSON calls, the page's `csrf-token` meta as `X-CSRF-Token`.
  - `plan.ts`: pure; creates go in one import per game (never `replace_stock`), updates/deletes one JSON call each.
    Created products carry `user_data_field = cardledger:<listing id>` (only `/products/<id>.json` returns it), which
    identifies them (fallback: a new product of the same blueprint / Cardmarket id / set + number or name,
    condition, language, foil). "My items" lags: after changes the adapter re-reads the touched and new products one
    by one. Results and stock carry `ct_blueprint_id` when CardTrader picked one CardLedger didn't know.
  - `adapter.ts`, `tab.ts`: as for Cardmarket. Ship: `markShipped` on the order page (tracking first).
- `src/markets/tab.ts`: shared tab lookup + agent injection/calls (`AgentCall<Request>`); `src/lib/forms.ts`:
  `formData`/`formAction` (posting a site's own forms) and `Pacer`.
- `src/content/cardledger.ts`: postMessage bridge on the CardLedger page (`cardledger:ping|sync|ship` →
  `…pong|sync-result|ship-result`); answers only same-window/same-origin messages on the configured origin.
- `src/popup/` (main view and Settings: CardLedger URL, unpair; no options page): plain TS + DOM (`src/ui/dom.ts` `h()` helper, text never parsed as HTML),
  `src/ui/style.css` light/dark.
- Build (`scripts/build.mjs`): one Vite build for pages + background (ES module), one IIFE build per content script
  (`content-cardledger`, `cardmarket-agent`, `cardtrader-agent`),
  then `manifest.json` from `scripts/manifest.mjs` (version from package.json).

## Tests

- `test/*.test.ts`, jsdom. `test/helpers.ts`: `fixture()`, `html()`, `change()`/`item()` plan factories,
  `jsonFetch()` route-based fetch mock. Each market site is faked by fixture routes with a fake clock
  (`cardmarket-agent.test.ts`, `cardtrader-agent.test.ts` check the pacing); adapters are tested with a fake
  `AgentCall` (`cardmarket-plan.test.ts`, `cardtrader.test.ts`).
- Never hit real services in tests.
