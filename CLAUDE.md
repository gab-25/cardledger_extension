# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome MV3 extension that syncs CardLedger (backend: sibling repo cardledger_core, Django; UI: cardledger_ui) with
Cardmarket ("cm") and CardTrader ("ct"). The server never talks to the markets for sync: the extension fetches a plan
from CardLedger, applies it on the market from the user's browser, and posts back a report. The CardLedger side of the
contract is `/api/extension/*` (token auth `Authorization: Token <token>`, obtained by pairing); its types are in
`src/types.ts`.

## Commands

```bash
npm test                                          # Vitest (jsdom), all tests
npx vitest run test/cardtrader.test.ts            # one file
npx vitest run test/cardtrader.test.ts -t "404"   # one test by name
npm run typecheck                                 # tsc --noEmit (strict)
npm run build                                     # tsc + scripts/build.mjs -> dist/ (load unpacked)
VITE_CARDLEDGER_URL=https://… npm run build       # default CardLedger URL (else http://localhost:5173)
```

## Rules (product decisions, don't break them)

- **User-initiated only**: no `alarms`, no timers, no work at startup besides registering the page bridge.
- **Human pace**: requests are sequential; Cardmarket pages ≥ `MIN_REQUEST_GAP_MS` apart (enforced in the agent);
  CardTrader job polling 1 req/s.
- **No Cardmarket credentials**: Cardmarket is driven inside the user's own tab with its session cookies; the
  extension never reads cookies or passwords. Only the CardLedger token (and settings, last runs) go in
  `chrome.storage.local`. The CardTrader token is fetched from CardLedger per run and never stored.
- **One report per run**, with a fresh uuid `run_id`, even on failure (`error` + whatever was done before).
- Host permissions: cardmarket.com, api.cardtrader.com, localhost/127.0.0.1, the build's default URL; any other
  CardLedger origin is requested at runtime from the options page (`optional_host_permissions`).

## Architecture

- `src/background.ts`: service worker; handles `chrome.runtime` messages (`src/messages.ts`: `sync`, `ship`, `pair`,
  `unpair`, `state`, `ping`), one sync at a time; registers the page bridge for the configured origin
  (`chrome.scripting.registerContentScripts`).
- `src/sync.ts`: `runSync(market, deps)` (plan → adapter → report, always reporting) and `runShip`. Dependencies are
  injected (`SyncDeps`) so tests mock CardLedger, CardTrader and the Cardmarket agent.
- `src/report.ts`: report building and the `RunSummary` shown in the popup / sent to the page.
- `src/api/cardledger.ts`: typed client of `/api/extension/*`; errors → `ApiError` (`code`, `fields`, `unauthorized`).
- `src/markets/cardtrader/`: `client.ts` is a port of cardledger_core `ledger/cardtrader.py` (same endpoints,
  bulk jobs, redirect = API down); `adapter.ts` ports `ledger/services.py` (blueprint resolution by expansion code +
  Cardmarket id/number/name, `product_payload`, `undescribed_reason`, order mapping). Keep them in step with the
  server code when it changes.
- `src/markets/cardmarket/`:
  - **`format.ts` — the assumptions module**: every Cardmarket URL, CSV column, code mapping, selector, label and
    date/money format. Nothing about Cardmarket's formats may live elsewhere. Unverified until real samples are
    captured (README, "Finalising the Cardmarket formats"); when correcting it, replace the fixtures in
    `test/fixtures/cardmarket/` with the real (redacted) samples first, then fix until tests pass.
  - `agent.ts`: runs in the cardmarket.com tab (built as IIFE, injected with `chrome.scripting.executeScript`,
    exposes `window.__cardledgerAgent.handle(request)`); does the page work (paced fetch, DOMParser, form posts).
    Service workers have no DOMParser: all HTML parsing happens here.
  - `plan.ts`: pure: splits the plan per game, verifies each change by diffing the stock export before/after
    the import (Cardmarket gives no per-row result).
  - `adapter.ts`: background-side orchestration over an `AgentCall`; `tab.ts` finds the tab and injects the agent.
- `src/content/cardledger.ts`: postMessage bridge on the CardLedger page (`cardledger:ping|sync|ship` →
  `…pong|sync-result|ship-result`); answers only same-window/same-origin messages on the configured origin.
- `src/popup/`, `src/options/`: plain TS + DOM (`src/ui/dom.ts` `h()` helper, text never parsed as HTML),
  `src/ui/style.css` light/dark.
- Build (`scripts/build.mjs`): one Vite build for pages + background (ES module), one IIFE build per content script,
  then `manifest.json` from `scripts/manifest.mjs` (version from package.json).

## Tests

- `test/*.test.ts`, jsdom. `test/helpers.ts`: `fixture()`, `html()`, `change()`/`item()` plan factories,
  `jsonFetch()` route-based fetch mock. CardTrader is faked in memory (`FakeCardTrader` in `cardtrader.test.ts`,
  after cardledger_core's), the Cardmarket site by fixture routes with a fake clock (`cardmarket-agent.test.ts`
  checks the pacing).
- Never hit real services in tests.
