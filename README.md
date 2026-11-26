# CardLedger Sync (Chrome extension)

Syncs your [CardLedger](https://github.com/gab-25/cardledger_core) listings and orders with **Cardmarket** and
**CardTrader**, from your own browser, only when you press **Sync**.

- **Cardmarket**: the extension works through your open, logged-in cardmarket.com tab: it reads your stock from
  *My Offers*, lists, edits and removes articles with the site's own forms and +/- buttons (no CSV: a private
  account has none), reads your Paid and Sent sales, and marks orders as sent.
- **CardTrader**: the same way, through your open, logged-in www.cardtrader.com tab: it reads your inventory from
  *My items*, creates products with *Sell via spreadsheet* (always adding, never replacing your inventory), edits and
  deletes them as the *My items* edit panel does, reads your paid and sent orders, and marks orders shipped (with the
  tracking code) on the order page. No CardTrader API token is used or stored anywhere.

Both use the browser's own session: your market passwords and cookies are never read or stored by the extension.
Nothing runs in the background: no timers, no polling. Requests are sequential, with at least 1.5 s between pages.

> **Status:** the stock/inventory side of both markets was checked on the real sites (2026-11-26, a private
> Cardmarket account and a CardTrader account); the orders pages and the ship actions are still educated guesses, as
> no order was available. See [Finalising the Cardmarket formats](#finalising-the-cardmarket-formats) and
> [Finalising the CardTrader formats](#finalising-the-cardtrader-formats).

## Install

Requirements: Node 20+ and Chrome 120+.

```bash
npm ci
npm run build   # -> dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Pin "CardLedger Sync" to the toolbar.

After pulling changes, `npm run build` again and press the reload icon on the extension's card.

### Production (Chrome Web Store)

```bash
npm run package   # -> cardledger-sync-<version>.zip
```

`npm run package` makes a production build (no localhost / 127.0.0.1 host permissions: a local CardLedger set in the
popup's *Settings* is then asked for like any other address) and zips `dist/` (needs the `zip` command). No build
contains a CardLedger URL: each user sets theirs in the popup (see [Set up](#set-up)). Bump `version` in `package.json` for each release: the Web Store
rejects an upload with a version it already has. Upload the zip in the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), visibility *Unlisted* (only
people with the link) or *Private* (your Google Workspace domain); installed copies update automatically.

**CI** (`.github/workflows/ci.yml`): every push to `main` runs the `test` job (typecheck and tests). Publishing a
release on GitHub runs `test`, then the `package` job (`npm run package`, the zip attached to the release). The version is `package.json`'s; the
tag only names the release.

## Set up

1. **CardLedger URL**: the popup opens on *Settings* until it is set (later: the gear icon, or *Change* under the
   pairing form). Enter the address you open CardLedger at (e.g. `https://ledger.example.com`; for development `http://localhost:5173`). A new address
   asks for permission to access it (the popup closes while Chrome asks; the address is saved once you allow it);
   localhost works out of the box in a development build. Changing it unpairs the extension. *Unpair* is in *Settings* too.
2. **Pair**: in CardLedger, open *Account → Browser extension* and create a pairing code (valid 10 minutes). Open
   the extension popup, type the code, press **Pair**. The extension stores the token it receives in
   `chrome.storage.local`; revoke it from the same Account page at any time (the extension then asks to pair again).
3. **CardTrader**: log in on www.cardtrader.com in a normal tab (the popup's *Open CardTrader* opens one).
4. **Cardmarket**: log in on www.cardmarket.com in a normal tab (*Open Cardmarket*). The games whose Cardmarket stock
   and orders are read on each sync are decided by CardLedger: the games you have Cardmarket listings of (the
   plan's `games`).

## Use

- **From the popup**, opened while on the market's own tab: *Sync Cardmarket* is enabled only on www.cardmarket.com,
  *Sync CardTrader* only on www.cardtrader.com. The popup shows each market's status and pending
  changes (from CardLedger), and the last run: changes applied, listings and orders read, errors per listing.
- **From CardLedger**: the Sync buttons in CardLedger ask the extension through the page bridge below; without the
  extension, CardLedger shows "Install the CardLedger extension".

Each run:

1. fetches the plan (`GET /api/extension/plan/?market=…`): listings to create, update or delete on that market;
2. applies it on the market;
3. reads back the market's stock and orders;
4. posts one report (`POST /api/extension/report/`) with a fresh `run_id`: always, also when the run fails (then
   with `error` and whatever was done before the failure).

CardTrader's created listings carry `cardledger:<listing id>` in the product's free field (`user_data_field`), so the
next sync tells which product is which; the blueprint CardTrader picked is reported back as `ct_blueprint_id`.

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

Everything about cardmarket.com is in **`src/markets/cardmarket/format.ts`** (URLs, CSS selectors, form fields, codes,
labels, date and money formats). Each block is marked `VERIFIED (date)` — checked on the real site, its fixture in
`test/fixtures/cardmarket/` is a real (redacted) page — or `ASSUMPTION` / `VERIFY` — still a guess. To finalise an
assumption, capture the sample **from your own seller account**, replace the fixture with it, then fix `format.ts`
until `npm test` is green again.

**How to capture a page**: the agent parses the HTML *as the server sends it*, not the page as rendered (Bootstrap
rewrites attributes such as `title` once the page runs). So fetch it from the DevTools console of a cardmarket.com tab,
e.g. `copy(await (await fetch("/en/Magic/Stock/Offers/Singles")).text())`, and paste into the fixture file. To see
what a form or button really posts, use DevTools → *Network*, submit it, select the request and look at *Payload*.
**Before saving or committing anything, remove personal data** (your username and user id, buyer names, addresses,
emails, tracking numbers) and never copy request headers: they contain your session cookie.

Verified on 2026-11-26 (private account): the logged-in header, *My Offers* (`offers-index.html`, `offers-singles.html`,
pagination with `?site=N`), the product page's sell form (`product-page.html`, `list-done.html`), the edit modal and
its AJAX answer (`edit-modal.html`, `ajax-edit-ok.xml`), the +/- quantity AJAX action, also removing the last copy (`ajax-amount-ok.xml`, `ajax-amount-removed.xml`), the
sales list URLs. Still to verify:

| # | Sample | Where | Fixture | Checks |
| --- | --- | --- | --- | --- |
| 1 | An offers row of a foil article, and one with a comment | My Offers → Singles | `offers-singles-2.html` (derived) | the foil marker (`parseOffersPage`), where a comment shows |
| 2 | The answer to a refused listing and to a refused edit (e.g. a price of 0) | Sell form / edit modal | `list-refused.html`, an AJAX XML | `SEL.alertError`, `parseAjaxResponse` on errors |
| 3 | Sales list with at least one order (and a second page if you have one) | Orders → Sales → Paid / Sent | `sales-paid.html` | order links (`SEL.salesOrderLink`) |
| 4 | An order page, one paid and one sent | Click an order | `order-paid.html`, `order-sent.html` | buyer, address parts, shipping method, timeline dates and labels, summary rows, article rows (`SEL.order.*`) |
| 5 | The ship forms of a paid order (tracking number, mark as sent) | Paid order page | `order-ship.html` | `SEL.ship.*`, the tracking input's name |
| 6 | Any page while logged out | Log out, open cardmarket.com | `logged-out.html` | `SEL.loginForm` |

Also note the game names in the URLs of each game you sell (`CM_GAMES`).

## Finalising the CardTrader formats

Same procedure for **`src/markets/cardtrader/format.ts`** and the fixtures in `test/fixtures/cardtrader/` (capture
from your own seller account, redact personal data, never copy request headers). CardTrader's pages are rendered by
React/Stimulus: fetch the HTML as the server sends it (see above), and look in DevTools → *Network* (filter
*Fetch/XHR*) for the JSON the page loads or sends: note URL, method, body and response.

Verified on 2026-11-26: the `/en-EU/` locale, the logged-in profile menu (`home.html`), *My items* as JSON
(`inventory-page.json`, `product.json`; the list is a search index that shows edits a few seconds late), the edit and
delete calls of its edit panel (`product-updated.json`), the import (`import-new.html`, `import-edit.html`,
`import-processing.html`, `import-result.html`; one game per import, columns named by the draft's mapping form), the
game ids, condition and language codes. Still to verify:

| # | Sample | Where | Fixture | Checks |
| --- | --- | --- | --- | --- |
| 1 | An import with a row CardTrader can't find, and one found only by expansion code + collector number | Sell via spreadsheet | `import-result.html` | the summary's error count (`parseImportStatus`), identification without blueprint / Cardmarket id |
| 2 | A foil product and a sealed product in *My items* | My items | `inventory-page.json` | `properties_hash` of foil / sealed products (`toCtStockRow`, `editBody`) |
| 3 | Orders as seller, paid and sent, with at least one order (and a second page if any) | My orders, as seller | `orders-paid.html` | `URLS.orders` (state filter values, `page` parameter), `SEL.ordersOrderLink` |
| 4 | An order page, one paid and one sent | Click an order | `order-paid.html`, `order-sent.html` | embedded JSON (`SEL.order.json`, `CtOrderJson`) or HTML (`SEL.order.*`), state names (`CT_STATES`) |
| 5 | Setting a tracking code and marking shipped on a paid order | Paid order page | `order-ship.html` | HTML forms (`SEL.ship.*`) or the JSON requests the buttons make |
| 6 | Any page while logged out, and where the login redirect goes | Log out, open www.cardtrader.com | `logged-out.html` | `SEL.loginForm`, `isSignInUrl` |

## Development

See [CLAUDE.md](CLAUDE.md) for the architecture. `npm test` (Vitest, jsdom), `npm run typecheck`, `npm run build`.
