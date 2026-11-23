// =====================================================================================================================
// CARDMARKET ASSUMPTIONS — every guess about cardmarket.com lives in this module, and nowhere else.
//
// Cardmarket has no API we may use, so the extension drives the seller's own pages, in a cardmarket.com tab, with the
// seller's session: it downloads the stock export CSV, uploads a stock import CSV, reads the sales pages, and submits
// the "mark as sent" form. NONE of the formats below were checked against the real site: they are realistic guesses
// (column names follow Cardmarket's historical "MKM" stock CSV). Correct them from real samples (README, section
// "Finalising the Cardmarket formats"), then update the fixtures in test/fixtures/cardmarket/ to the real ones: the
// tests in format.test.ts pin every parser and generator to those fixtures.
//
// Each block says what is assumed (ASSUMPTION) and what to look at to verify it (VERIFY).
// =====================================================================================================================

import { detectDelimiter, parseCsvRecords, writeCsv } from "../../lib/csv";
import { normalizeNumber } from "../../lib/util";
import type { OrderItemRow, OrderRow, OrderState, PlanChange, StockRow } from "../../types";

// --- site, pacing -------------------------------------------------------------------------------------------------

export const ORIGIN = "https://www.cardmarket.com";
/** Language segment of every URL; the page texts matched below are the English ones. */
export const SITE_LANGUAGE = "en";
/** Minimum pause between two requests to cardmarket.com (the rule is ≥ 1 s; a bit more to look human). */
export const MIN_REQUEST_GAP_MS = 1500;
/** Stock export may be generated asynchronously: how many times to look for the file, and how long to wait between. */
export const EXPORT_POLL_ATTEMPTS = 5;
export const EXPORT_POLL_GAP_MS = 3000;
/** At most this many pages of each sales list are read per run. */
export const MAX_ORDER_PAGES = 5;

// ASSUMPTION: each game has its own section of the site, named like this in the URL (/en/Magic/...).
// VERIFY: the game switcher links on cardmarket.com. CardLedger slugs not listed here are not synced on Cardmarket.
export const CM_GAMES: Record<string, string> = {
  mtg: "Magic",
  pokemon: "Pokemon",
  yugioh: "YuGiOh",
  onepiece: "OnePiece",
  lorcana: "Lorcana",
  riftbound: "Riftbound",
  fab: "FleshAndBlood",
  swu: "StarWarsUnlimited",
  dbs: "DragonBallSuper",
  digimon: "Digimon",
};

export function gamePath(slug: string): string {
  const path = CM_GAMES[slug];
  if (!path) throw new Error(`Game "${slug}" is not known on Cardmarket (see CM_GAMES in cardmarket/format.ts).`);
  return path;
}

// ASSUMPTION: the seller pages are at these URLs. VERIFY: open each from Cardmarket's menus (Stock, Orders > Sales)
// and compare the address bar.
export const URLS = {
  home: () => `${ORIGIN}/${SITE_LANGUAGE}/Magic`,
  /** The page with the "export stock" form (or the list of generated export files). */
  stockExport: (game: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Stock/Export`,
  /** The page with the "upload a CSV file" form. */
  stockImport: (game: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Stock/Import`,
  /** One article of the seller's stock (only for DELETE_STRATEGY "article-form"). */
  article: (game: string, articleId: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Stock/Offers/${articleId}`,
  /** Sales by state, paginated with ?site=N (1-based). */
  sales: (game: string, state: "Paid" | "Sent", page = 1) =>
    `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Orders/Sales/${state}${page > 1 ? `?site=${page}` : ""}`,
  order: (game: string, orderId: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Orders/${orderId}`,
};

// --- selectors -------------------------------------------------------------------------------------------------------

// ASSUMPTION: these CSS selectors find the parts of the pages. Several alternatives are tried in order (comma lists
// are standard CSS). VERIFY: in DevTools (Elements panel) on each page.
export const SEL = {
  /** Present only when logged in; its text is the seller's username. */
  username: "#account-dropdown .username, [data-cl-username], a.dropdown-toggle[href*='/Account'] span",
  /** Present on the login form (logged out). */
  loginForm: "form[action*='PostGetAction/User_Login'], form#loginForm",
  exportForm: "form#StockExportForm, form[action*='Export']",
  /** Link to a generated export file. */
  exportDownload: "a[href*='/Download'], a[href$='.csv'], a[href*='Export/File']",
  importForm: "form#StockImportForm, form[action*='Import']",
  importFile: "input[type='file']",
  alertSuccess: ".alert-success",
  alertError: ".alert-danger, .alert-warning",
  /** Delete button form on an article page. */
  articleRemoveForm: "form[action*='Remove'], form#RemoveArticleForm",
  /** Order links on a sales list page; the id is the number at the end of the href. */
  salesOrderLink: "a[href*='/Orders/']",
  order: {
    buyer: "#Buyer a[href*='/Users/'], .buyer-info a[href*='/Users/']",
    address: "#ShippingAddress",
    addressName: ".Name",
    addressExtra: ".Extra",
    addressStreet: ".Street",
    /** "10115 Berlin": postcode then city. */
    addressCity: ".City",
    addressCountry: ".Country",
    shippingMethod: "#ShippingMethod .method-name, #ShippingMethod",
    trackingCode: "#TrackingNumber, .tracking-number",
    /** Timeline rows: a .label ("Paid", "Shipped", ...) and a .date ("21.11.2026 14:03"). */
    timelineRow: "#Timeline .timeline-row",
    /** Summary rows: a .label and a .value ("12,34 €"). */
    summaryRow: "#OrderSummary .summary-row",
    articleRow: "table.product-table tbody tr[data-article-id], #Articles tr[data-article-id]",
  },
  ship: {
    trackingForm: "form#TrackingNumberForm, form[action*='Tracking']",
    trackingInput: "input[name='trackingNumber'], input[name*='racking']",
    sendForm: "form#ConfirmShippingForm, form[action*='Send'], form[action*='Shipped']",
  },
};

// ASSUMPTION: summary and timeline labels (English site). VERIFY: on an order page.
export const LABELS = {
  itemsTotal: /article value|articles? total|subtotal/i,
  shipping: /shipping/i,
  fee: /commission|fee/i,
  total: /^total/i,
  paid: /^paid/i,
  sent: /^(shipped|sent)/i,
  /** Shipping methods named like this have a tracking number. */
  trackedMethod: /tracked|registered|insured|einschreiben|raccomandata/i,
};

/**
 * Cardmarket's dates are written "dd.mm.yyyy HH:MM" in Central European time (ASSUMPTION; VERIFY on an order page).
 * Returns ISO 8601 with the right offset (+01:00 / +02:00), or null.
 */
export function parseCmDate(text: string | null | undefined): string | null {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/.exec(text ?? "");
  if (!m) return null;
  const [, d, mo, y, h = "0", mi = "0"] = m;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi);
  const offsetMin = berlinOffsetMinutes(new Date(wall - 60 * 60 * 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = offsetMin >= 0 ? "+" : "-";
  return `${y}-${pad(+mo!)}-${pad(+d!)}T${pad(+h)}:${pad(+mi)}:00${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

function berlinOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((local - at.getTime()) / 60000);
}

/** "12,34 €", "€ 12.34", "1.234,50 €" -> "12.34" / "1234.50"; null when there is no number. */
export function parseCmMoney(text: string | null | undefined): string | null {
  const raw = (text ?? "").replace(/[^\d.,-]/g, "");
  if (!/\d/.test(raw)) return null;
  const lastSep = Math.max(raw.lastIndexOf(","), raw.lastIndexOf("."));
  let normalized: string;
  if (lastSep >= 0 && raw.length - lastSep - 1 <= 2) {
    normalized = raw.slice(0, lastSep).replace(/[.,]/g, "") + "." + raw.slice(lastSep + 1);
  } else {
    normalized = raw.replace(/[.,]/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

/** The currency of a money text ("12,34 €" -> "EUR"). ASSUMPTION: Cardmarket sells in EUR unless £ shows. */
export function parseCmCurrency(text: string | null | undefined): string {
  if (/£|GBP/.test(text ?? "")) return "GBP";
  if (/CHF/.test(text ?? "")) return "CHF";
  return "EUR";
}

// --- codes -----------------------------------------------------------------------------------------------------------

// ASSUMPTION: the CSV uses Cardmarket's language ids (MKM API: 1 English ... 10 Korean). The parser also accepts
// language names. VERIFY: the Language column of a real export.
export const LANGUAGE_IDS: Record<string, number> = {
  EN: 1, FR: 2, DE: 3, ES: 4, IT: 5, ZHS: 6, JP: 7, PT: 8, RU: 9, KO: 10,
};
const LANGUAGE_NAMES: Record<string, string> = {
  english: "EN", french: "FR", german: "DE", spanish: "ES", italian: "IT", "s-chinese": "ZHS",
  "simplified chinese": "ZHS", japanese: "JP", portuguese: "PT", russian: "RU", korean: "KO",
};

export function languageFromCm(value: string): string {
  const v = value.trim();
  const byId = Object.entries(LANGUAGE_IDS).find(([, id]) => String(id) === v);
  if (byId) return byId[0];
  return LANGUAGE_NAMES[v.toLowerCase()] ?? v.toUpperCase();
}

// ASSUMPTION: conditions are Cardmarket's grade codes; the Ledger uses the same ones except Mint ("M" vs "MT").
// VERIFY: the Condition column of a real export.
export const CONDITION_TO_CM: Record<string, string> = { M: "MT", NM: "NM", EX: "EX", GD: "GD", LP: "LP", PL: "PL", PO: "PO" };
const CONDITION_NAMES: Record<string, string> = {
  mint: "M", "near mint": "NM", excellent: "EX", good: "GD", "light played": "LP", played: "PL", poor: "PO",
};

export function conditionFromCm(value: string): string {
  const v = value.trim();
  const byCode = Object.entries(CONDITION_TO_CM).find(([, cm]) => cm === v.toUpperCase());
  if (byCode) return byCode[0];
  return CONDITION_NAMES[v.toLowerCase()] ?? v.toUpperCase();
}

/** ASSUMPTION: boolean columns are "X" (or "1"/"true"/"yes") when set, empty otherwise. */
export function flag(value: string | undefined): boolean {
  return /^(x|1|true|yes|y)$/i.test((value ?? "").trim());
}

// --- stock export CSV --------------------------------------------------------------------------------------------------

// ASSUMPTION: the stock export is a ";"-separated UTF-8 CSV with a header row and these columns (MKM stock export).
// Only the ones named in STOCK_COLUMNS are read; any other column is ignored, and the delimiter is detected.
// VERIFY: export the stock of a game from the seller tools and compare its header.
export const STOCK_COLUMNS = {
  articleId: ["idArticle", "Article ID"],
  productId: ["idProduct", "Product ID"],
  name: ["English Name", "Name", "Product"],
  setCode: ["Exp.", "Expansion Code", "Set"],
  setName: ["Exp. Name", "Expansion"],
  number: ["Collector Number", "Number", "Nr."],
  price: ["Price"],
  language: ["Language"],
  condition: ["Condition"],
  foil: ["Foil?", "Foil", "isFoil"],
  amount: ["Amount", "Quantity", "Count"],
  comments: ["Comments", "Comment"],
} as const;

type Column = keyof typeof STOCK_COLUMNS;

function pick(record: Record<string, string>, column: Column): string {
  for (const name of STOCK_COLUMNS[column]) {
    if (name in record) return record[name] ?? "";
  }
  return "";
}

/** Parse a stock export into the report's `stock` rows (rows without an article id are skipped). */
export function parseStockCsv(text: string): StockRow[] {
  const records = parseCsvRecords(text, detectDelimiter(text));
  const rows: StockRow[] = [];
  for (const r of records) {
    const articleId = pick(r, "articleId").trim();
    if (!articleId) continue;
    const productId = Number(pick(r, "productId"));
    rows.push({
      market_listing_id: articleId,
      cm_product_id: Number.isFinite(productId) && productId > 0 ? productId : null,
      name: pick(r, "name").trim(),
      set_code: pick(r, "setCode").trim().toUpperCase(),
      collector_number: normalizeNumber(pick(r, "number")),
      condition: conditionFromCm(pick(r, "condition")),
      language: languageFromCm(pick(r, "language")),
      foil: flag(pick(r, "foil")),
      quantity: Number.parseInt(pick(r, "amount"), 10) || 0,
      price: parseCmMoney(pick(r, "price")) ?? "0.00",
    });
  }
  return rows;
}

/** Is this download a CSV (and not an HTML page)? */
export function looksLikeCsv(text: string, contentType = ""): boolean {
  if (/csv|octet-stream|text\/plain/i.test(contentType)) return true;
  const head = text.replace(/^﻿/, "").slice(0, 200);
  return !/<html|<!doctype/i.test(head) && STOCK_COLUMNS.articleId.some((c) => head.includes(c));
}

// --- stock import CSV --------------------------------------------------------------------------------------------------

// ASSUMPTION: the stock import takes a ";"-separated CSV with this header. A row with an empty idArticle creates a new
// article; a row with an idArticle updates that article to the given Amount/Price (it does not add to it).
// VERIFY: the import page's template/help (download the sample file if it offers one), then try one update on a
// cheap card and check that the amount was replaced, not added.
export const IMPORT_HEADER = [
  "idArticle", "idProduct", "Amount", "Price", "Language", "Condition", "Foil?", "Signed?", "Altered?", "Playset?", "Comments",
];
export const IMPORT_DELIMITER = ";";

// ASSUMPTION: how a removal is expressed. "import-zero": a row with the idArticle and Amount 0 removes the article;
// "article-form": the import can't remove, the article's own page has a remove form (SEL.articleRemoveForm).
// VERIFY: try a removal through the import on a cheap card; if it is refused or ignored, switch to "article-form".
export const DELETE_STRATEGY: "import-zero" | "article-form" = "import-zero";

/** The import CSV row of a plan change (delete: only with DELETE_STRATEGY "import-zero"). */
export function importRow(change: PlanChange): Array<string | number> {
  const item = change.item;
  const remove = change.action === "delete";
  return [
    change.action === "create" ? "" : change.market_listing_id,
    item.cm_product_id ?? "",
    remove ? 0 : change.quantity,
    Number(change.price).toFixed(2),
    LANGUAGE_IDS[item.language] ?? "",
    CONDITION_TO_CM[item.condition] ?? item.condition,
    item.foil ? "X" : "",
    "",
    "",
    "",
    change.comment ?? "",
  ];
}

export function buildImportCsv(changes: PlanChange[]): string {
  return writeCsv(IMPORT_HEADER, changes.map(importRow), IMPORT_DELIMITER);
}

// --- pages -------------------------------------------------------------------------------------------------------------

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The logged-in seller's username, or null when the page shows the login form / no account menu. */
export function parseUsername(doc: Document): string | null {
  const el = doc.querySelector(SEL.username);
  const name = el?.getAttribute("data-cl-username") || text(el);
  return name || null;
}

/** First message of a success / error alert on a page after a form post. */
export function parseAlerts(doc: Document): { success: string | null; error: string | null } {
  return {
    success: text(doc.querySelector(SEL.alertSuccess)) || null,
    error: text(doc.querySelector(SEL.alertError)) || null,
  };
}

/** Absolute URL of the generated export file on the export page, if any. */
export function parseExportLink(doc: Document): string | null {
  const href = doc.querySelector(SEL.exportDownload)?.getAttribute("href");
  return href ? new URL(href, ORIGIN).toString() : null;
}

/** Order ids linked from a sales list page, in page order, without duplicates. */
export function parseSalesList(doc: Document): string[] {
  const ids: string[] = [];
  for (const a of doc.querySelectorAll(SEL.salesOrderLink)) {
    const m = /\/Orders\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute("href") ?? "");
    if (m && !ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}

// ASSUMPTION: an order page lists its articles as table rows carrying data-* attributes:
//   data-article-id, data-product-id, data-name, data-expansion, data-language (name or id), data-condition (code),
//   data-foil ("1"/"0"), data-amount, data-price ("1,50 €").
// When an attribute is missing, the cells are tried: .name, .expansion, .condition, .language [title], .foil, .amount,
// .price. VERIFY: inspect an article row of a real order.
function articleRow(row: Element, orderId: string, index: number): OrderItemRow {
  const attr = (n: string) => row.getAttribute(`data-${n}`);
  const cell = (cls: string) => row.querySelector(`.${cls}`);
  const articleId = attr("article-id") ?? "";
  const language = attr("language") ?? cell("language")?.getAttribute("title") ?? text(cell("language"));
  const foilAttr = attr("foil");
  return {
    market_item_id: articleId ? `${orderId}-${articleId}` : `${orderId}-${index + 1}`,
    market_listing_id: articleId || undefined,
    name: attr("name") ?? text(cell("name")),
    expansion: attr("expansion") ?? text(cell("expansion")),
    condition: conditionFromCm(attr("condition") ?? text(cell("condition"))),
    language: languageFromCm(language),
    foil: foilAttr !== null ? flag(foilAttr) : !!cell("foil"),
    quantity: Number.parseInt(attr("amount") ?? text(cell("amount")), 10) || 1,
    price: parseCmMoney(attr("price") ?? text(cell("price"))),
  };
}

/** Parse an order page. state comes from the sales list it was found on (Paid / Sent). */
export function parseOrderPage(doc: Document, orderId: string, state: OrderState): OrderRow {
  const o = SEL.order;
  const address = doc.querySelector(o.address);
  const part = (sel: string) => text(address?.querySelector(sel));
  const cityLine = part(o.addressCity);
  const cityMatch = /^(\S*\d\S*)\s+(.*)$/.exec(cityLine);
  const method = text(doc.querySelector(o.shippingMethod));

  const dates: { paid: string | null; sent: string | null } = { paid: null, sent: null };
  for (const row of doc.querySelectorAll(o.timelineRow)) {
    const label = text(row.querySelector(".label"));
    const date = parseCmDate(text(row.querySelector(".date")));
    if (LABELS.paid.test(label)) dates.paid = date;
    else if (LABELS.sent.test(label)) dates.sent = date;
  }

  const sums: { items: string | null; shipping: string | null; fee: string | null; total: string | null; currency: string } = {
    items: null, shipping: null, fee: null, total: null, currency: "EUR",
  };
  for (const row of doc.querySelectorAll(o.summaryRow)) {
    const label = text(row.querySelector(".label"));
    const valueText = text(row.querySelector(".value"));
    const value = parseCmMoney(valueText);
    if (LABELS.total.test(label)) {
      sums.total = value;
      sums.currency = parseCmCurrency(valueText);
    } else if (LABELS.itemsTotal.test(label)) sums.items = value;
    else if (LABELS.fee.test(label)) sums.fee = value;
    else if (LABELS.shipping.test(label)) sums.shipping = value;
  }

  const tracking = doc.querySelector(o.trackingCode);
  const name = part(o.addressName);
  return {
    market_order_id: orderId,
    state,
    buyer_username: text(doc.querySelector(o.buyer)),
    buyer_name: name,
    ship_name: name,
    ship_street: [part(o.addressStreet), part(o.addressExtra)].filter(Boolean).join(", "),
    ship_zip: cityMatch ? cityMatch[1]! : "",
    ship_city: cityMatch ? cityMatch[2]! : cityLine,
    ship_province: "",
    ship_country: part(o.addressCountry),
    ship_country_code: "",
    ship_note: "",
    shipping_method: method,
    tracked: LABELS.trackedMethod.test(method),
    tracking_code: (tracking instanceof HTMLInputElement ? tracking.value : text(tracking)).trim(),
    paid_at: dates.paid,
    sent_at: dates.sent,
    items_total: sums.items,
    shipping_cost: sums.shipping,
    market_fee: sums.fee,
    total: sums.total,
    net: sums.total !== null ? (Number(sums.total) - Number(sums.fee ?? 0)).toFixed(2) : null,
    currency: sums.currency,
    items: [...doc.querySelectorAll(o.articleRow)].map((row, i) => articleRow(row, orderId, i)),
  };
}

/**
 * The fields of a form as Cardmarket would post them (hidden inputs such as the anti-CSRF token included), with
 * overrides. ASSUMPTION: Cardmarket's forms are plain HTML forms posted to their action with the session cookie.
 */
export function formData(form: HTMLFormElement, overrides: Record<string, string | Blob> = {}, fileName = "stock.csv"): FormData {
  const data = new FormData();
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
    if (!el.name || el.disabled) continue;
    if (el instanceof HTMLInputElement) {
      if (el.type === "file" || el.type === "submit" || el.type === "button") continue;
      if ((el.type === "checkbox" || el.type === "radio") && !el.checked) continue;
    }
    data.append(el.name, el.value);
  }
  for (const [k, v] of Object.entries(overrides)) {
    data.delete(k);
    if (typeof v === "string") data.append(k, v);
    else data.append(k, v, fileName);
  }
  return data;
}

export function formAction(form: HTMLFormElement, pageUrl: string): string {
  return new URL(form.getAttribute("action") || pageUrl, pageUrl).toString();
}
