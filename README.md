# CardLedger Sync (Chrome extension)

Syncs your [CardLedger](https://github.com/gab-25/cardledger_core) listings and orders with **Cardmarket** and
**CardTrader**, from your own browser, only when you press **Sync**.

- **CardTrader**: the extension calls CardTrader's official API v2 with your CardTrader token (saved in CardLedger and
  fetched from it at sync time). It publishes, updates and removes your listings, and reads back your products and
  orders.
- **Cardmarket**: there is no API to use, so the extension works through your open, logged-in cardmarket.com tab:
  it downloads your stock export, uploads a stock import CSV with the changes, reads your Paid and Sent sales, and
  marks orders as sent. It uses the browser's own session: your Cardmarket password and cookies are never read or
  stored by the extension.

Nothing runs in the background: no timers, no polling. Requests are sequential, with at least 1.5 s between
Cardmarket pages.

> **Status:** the Cardmarket file formats and page structure are educated guesses until they are checked against real
> samples. See [Finalising the Cardmarket formats](#finalising-the-cardmarket-formats) before syncing Cardmarket for
> real. CardTrader follows exactly what CardLedger's server already does.

## Install

Requirements: Node 20+ and Chrome 120+.

```bash
npm ci
npm run build                                                  # dist/, default CardLedger URL http://localhost:5173
VITE_CARDLEDGER_URL=https://ledger.example.com npm run build   # or with your CardLedger's URL as default
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Pin "CardLedger Sync" to the toolbar.

After pulling changes, `npm run build` again and press the reload icon on the extension's card.

## Set up

1. **CardLedger URL**: right-click the extension icon → *Options* (or *Options* in the popup). Enter the address you
   open CardLedger at (e.g. `https://ledger.example.com`; for development `http://localhost:5173`). A new address
   asks for permission to access it; localhost works out of the box. Changing it unpairs the extension.
2. **Pair**: in CardLedger, open *Account → Browser extension* and create a pairing code (valid 10 minutes). Open
   the extension popup, type the code, press **Pair**. The extension stores the token it receives in
   `chrome.storage.local`; revoke it from the same Account page at any time (the extension then asks to pair again).
3. **CardTrader**: save your CardTrader API token in CardLedger (Account). The extension fetches it at each sync.
4. **Cardmarket**: log in on cardmarket.com in a normal tab and leave it open while syncing. In the options, tick
   the games whose Cardmarket stock and orders you want read on each sync (games with changes to push are always
   included).

## Use

- **From the popup**: *Sync Cardmarket* / *Sync CardTrader*. The popup shows each market's status and pending
  changes (from CardLedger), and the last run: changes applied, listings and orders read, errors per listing.
- **From CardLedger**: the Sync buttons in CardLedger ask the extension through the page bridge below; without the
  extension, CardLedger shows "Install the CardLedger extension".

Each run:

1. fetches the plan (`GET /api/extension/plan/?market=…`): listings to create, update or delete on that market;
2. applies it on the market;
3. reads back the market's stock and orders;
4. posts one report (`POST /api/extension/report/`) with a fresh `run_id`: always, also when the run fails (then
   with `error` and whatever was done before the failure).

Marking an order shipped (with its tracking code) is done by the extension too, then confirmed to CardLedger with
`POST /api/extension/shipped/`.

### Page bridge (for CardLedger UI developers)

A content script runs on the configured CardLedger origin and answers `window.postMessage` from the page itself
(same window and origin). Every message may carry an `id`, echoed back.

| Page sends | Extension answers |
| --- | --- |
| `{type: "cardledger:ping", id?}` | `{type: "cardledger:pong", id, version, paired}` |
| `{type: "cardledger:sync", id?, market: "cm" \| "ct"}` | `{type: "cardledger:sync-result", id, market, ok, run?, error?}`; `run` is the run summary (`run_id`, counts, `failures`, CardLedger's report `response`) |
| `{type: "cardledger:ship", id?, market, market_order_id, tracking_code?, game?}` | `{type: "cardledger:ship-result", id, market, market_order_id, ok, error?}` (`game`: CardLedger slug of a Cardmarket order, default `mtg`) |

No pong within 1 s means the extension is not installed (or not configured for this CardLedger URL).

## Finalising the Cardmarket formats

Every assumption about cardmarket.com is in **`src/markets/cardmarket/format.ts`** (URLs, CSV columns and codes,
CSS selectors, labels, date and money formats), each marked `ASSUMPTION` / `VERIFY`. The fixtures in
`test/fixtures/cardmarket/` follow those assumptions. To finalise, capture these samples **from your own seller
account**, replace the fixtures with them, then fix `format.ts` until `npm test` is green again.

**How to capture a page**: open it in Chrome, DevTools (F12) → *Elements* → right-click the `<html>` node → *Copy* →
*Copy outerHTML*, paste into the fixture file. This gets the page as rendered (also what scripts add). To see what a
form really posts (field names, action URL), use DevTools → *Network*, submit the form, select the request and look
at *Payload*. **Before saving or committing anything, remove personal data** (buyer names, addresses, emails,
tracking numbers) and never copy request headers: they contain your session cookie.

| # | Sample | Where | Fixture | Checks |
| --- | --- | --- | --- | --- |
| 1 | Stock export CSV (a few rows are enough: one foil, one non-English, one with a comment) | Seller tools → Stock → Export (one game) | `stock-export.csv` | delimiter, header names (`STOCK_COLUMNS`), language as id or name, condition codes, foil flag, price decimal separator, collector number column |
| 2 | Stock export page, before and after requesting an export | Same page | `export-page.html`, `export-ready.html` | export URL (`URLS.stockExport`), form (`SEL.exportForm`), whether the file downloads right away or appears as a link later (`SEL.exportDownload`) |
| 3 | Stock import page + its template/help text (and the sample CSV if it offers one) | Seller tools → Stock → Import / Upload CSV | `import-page.html`, `import-expected.csv` | import URL, form and file field, `IMPORT_HEADER`, whether a row with `idArticle` replaces or adds to the amount, whether Amount 0 removes (`DELETE_STRATEGY`) |
| 4 | The page shown after an import, successful and refused | After uploading (try a 1-row file with a cheap card) | `import-done.html`, `import-refused.html` | `SEL.alertSuccess` / `SEL.alertError` |
| 5 | Sales list, Paid and Sent, with at least one order (and a second page if you have one) | Orders → Sales → Paid / Sent | `sales-paid.html` | URLs (`URLS.sales`, `?site=N`), order links (`SEL.salesOrderLink`) |
| 6 | An order page, one paid and one sent | Click an order | `order-paid.html`, `order-sent.html` | buyer, address parts, shipping method, timeline dates and labels, summary rows (article value, shipping, commission, total), article rows (`SEL.order.articleRow` and their data-attributes/cells) |
| 7 | The ship forms of a paid order (tracking number, mark as sent) | Paid order page | `order-ship.html` | `SEL.ship.*`, the tracking input's name |
| 8 | Any page while logged out | Log out, open cardmarket.com | `logged-out.html` | `SEL.loginForm`, and `SEL.username` on the logged-in pages above |
| 9 | The stock page of one article (only if Amount 0 can't remove through the import) | Stock → an article | new fixture | `URLS.article`, `SEL.articleRemoveForm` |

Also note the game names in the URLs of each game you sell (`CM_GAMES`).

## Development

See [CLAUDE.md](CLAUDE.md) for the architecture. `npm test` (Vitest, jsdom), `npm run typecheck`, `npm run build`.
