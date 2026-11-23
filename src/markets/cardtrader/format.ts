// =====================================================================================================================
// CARDTRADER ASSUMPTIONS — every guess about www.cardtrader.com lives in this module, and nowhere else.
//
// CardTrader is synced like Cardmarket: no API token, the extension drives the seller's own pages in a logged-in
// www.cardtrader.com tab, with the seller's session. It downloads the inventory export CSV, uploads an inventory
// import CSV, reads the seller's orders (paid / sent) and each order page, and marks an order shipped (with its
// tracking code) on the order page. NONE of the formats below were checked against the real site (cardtrader.com
// refuses automated fetches, so not even its help pages could be read): they are educated guesses. CardTrader's web
// app is assumed to be a Rails app (csrf-token meta tag, Devise sign-in at /users/sign_in, forms with
// authenticity_token and _method) whose Vue pages get their data embedded in the HTML in the same shape as CardTrader's
// public API v2 (e.g. an order: id, state, buyer, order_items, seller_total {cents, currency}...).
//
// Correct them from real samples (README, "Finalising the CardTrader formats"), replace the fixtures in
// test/fixtures/cardtrader/ with the real (redacted) ones, then fix this module until `npm test` is green.
// Each block says what is assumed (ASSUMPTION) and what to look at to verify it (VERIFY).
// =====================================================================================================================

import { detectDelimiter, parseCsvRecords, writeCsv } from "../../lib/csv";
import { fromCents, normalizeNumber } from "../../lib/util";
import type { OrderItemRow, OrderRow, OrderState, PlanChange, StockRow } from "../../types";

// --- site, pacing -------------------------------------------------------------------------------------------------

export const ORIGIN = "https://www.cardtrader.com";
/** Language segment of every URL; the page texts matched below are the English ones. */
export const SITE_LANGUAGE = "en";
/** Minimum pause between two requests to cardtrader.com (≥ 1.5 s, like Cardmarket). */
export const MIN_REQUEST_GAP_MS = 1500;
/** The export may be generated asynchronously: how many times to look for the file, and how long to wait between. */
export const EXPORT_POLL_ATTEMPTS = 5;
export const EXPORT_POLL_GAP_MS = 3000;
/**
 * ASSUMPTION: an uploaded import is processed in the background within a few seconds; the agent waits this long
 * before the inventory is exported again to verify it. VERIFY: after an upload, how long until the inventory changes
 * (if the import page shows a progress/job status, poll that instead).
 */
export const IMPORT_SETTLE_MS = 5000;
/** At most this many pages of each orders list are read per run. */
export const MAX_ORDER_PAGES = 5;

// ASSUMPTION: the seller pages are at these URLs (the inventory is one, across games). VERIFY: open each from
// CardTrader's menus (Sell → Inventory, Export, Import; Orders → Sold, filtered by state) and compare the address bar.
export const URLS = {
  home: () => `${ORIGIN}/${SITE_LANGUAGE}`,
  /** The page with the "export inventory (CSV)" form, or the list of generated export files. */
  inventoryExport: () => `${ORIGIN}/${SITE_LANGUAGE}/manage/products/export`,
  /** The page with the "import from file (CSV)" form. */
  inventoryImport: () => `${ORIGIN}/${SITE_LANGUAGE}/manage/products/import`,
  /** One product of the inventory (only for DELETE_STRATEGY "product-form"). */
  product: (productId: string) => `${ORIGIN}/${SITE_LANGUAGE}/manage/products/${productId}/edit`,
  /** The seller's orders in a state, paginated with ?page=N (1-based). */
  orders: (state: CtListState, page = 1) =>
    `${ORIGIN}/${SITE_LANGUAGE}/orders?order_as=seller&state=${state}${page > 1 ? `&page=${page}` : ""}`,
  order: (orderId: string) => `${ORIGIN}/${SITE_LANGUAGE}/orders/${orderId}`,
  // ASSUMPTION: the order page's Vue buttons call these same-origin JSON endpoints (PUT, X-CSRF-Token header), which
  // mirror the API v2 ones (PUT /orders/:id/tracking_code {tracking_code}, PUT /orders/:id/ship). Used only when the
  // order page has no HTML form for the action. VERIFY: DevTools → Network while saving a tracking code / shipping.
  orderTrackingJson: (orderId: string) => `${ORIGIN}/${SITE_LANGUAGE}/orders/${orderId}/tracking_code`,
  orderShipJson: (orderId: string) => `${ORIGIN}/${SITE_LANGUAGE}/orders/${orderId}/ship`,
};

/** The two seller order lists read on each sync (ASSUMPTION: the `state` filter values of the orders page). */
export type CtListState = "paid" | "sent";

/** A response that ended on the sign-in page (Rails/Devise redirect) means the session is gone. */
export function isSignInUrl(url: string): boolean {
  return /\/users\/sign_in\b/.test(url);
}

// ASSUMPTION: CardTrader's game ids (as in API v2 GET /games). The import needs the game only to find a card by
// expansion code + collector number when neither a blueprint nor a Cardmarket id is known. VERIFY: the game filter of
// the inventory page (its option values) or the game column of an export. Slugs not listed: only items with a
// blueprint or Cardmarket id can be created.
export const CT_GAMES: Record<string, number> = {
  mtg: 1,
  yugioh: 4,
  pokemon: 5,
  fab: 6,
  onepiece: 15,
  lorcana: 18,
  swu: 20,
  riftbound: 22,
};

// --- selectors -------------------------------------------------------------------------------------------------------

// ASSUMPTION: these CSS selectors find the parts of the pages; comma lists are tried as standard CSS.
// VERIFY: in DevTools (Elements panel) on each page.
export const SEL = {
  /** Present only when logged in; its text (or data-username) is the seller's username. */
  username: "[data-cl-username], .navbar .user-menu [data-username], .navbar .user-menu .username",
  /** Devise's sign-in form (logged out). */
  loginForm: "form[action*='/users/sign_in'], form#new_user",
  /** Rails' anti-CSRF token, sent as X-CSRF-Token by the site's own JSON requests. */
  csrfToken: "meta[name='csrf-token']",
  exportForm: "form#export-products-form, form[action*='products/export']",
  /** Link to a generated export file. */
  exportDownload: "a[href$='.csv'], a[href*='/exports/'][href*='download']",
  importForm: "form#import-products-form, form[action*='products/import']",
  importFile: "input[type='file']",
  /** Rails flash messages. */
  alertSuccess: ".alert-success, .flash-notice",
  alertError: ".alert-danger, .alert-error, .flash-alert",
  /** The delete form on a product's page (Rails button_to: method=post with a hidden _method=delete). */
  productRemoveForm: "form#delete-product-form, form.button_to[action*='/manage/products/']",
  /** Order links on an orders list; the id is the number right after /orders/. */
  ordersOrderLink: "a[href*='/orders/']",
  order: {
    /**
     * The order serialized as API v2 JSON, either in a data-order attribute (the Vue mount point) or in a JSON script.
     * Read first; the DOM selectors below are the fallback when the page renders the order as HTML.
     */
    json: "[data-order], script#order-data[type='application/json']",
    buyer: ".order-buyer .username, .order-buyer a[href*='/users/']",
    address: ".order-shipping-address",
    /** Parts of the address block. */
    addressName: ".name",
    addressStreet: ".street",
    addressZip: ".zip",
    addressCity: ".city",
    addressProvince: ".state",
    addressCountry: ".country",
    shippingMethod: ".order-shipping-method .name, .order-shipping-method",
    trackingCode: ".order-tracking-code, input[name*='tracking_code']",
    /** Timeline events with a .label ("Paid", "Sent"...) and a <time datetime="ISO">. */
    timelineRow: ".order-timeline li",
    /** Totals rows: a .label and a .value ("€12.34"). */
    summaryRow: ".order-summary .summary-row",
    itemRow: ".order-items tr[data-item-id]",
  },
  ship: {
    trackingForm: "form#tracking-code-form, form[action*='tracking_code']",
    trackingInput: "input[name='tracking_code'], input[name*='[tracking_code]']",
    shipForm: "form#ship-order-form, form[action$='/ship']",
  },
};

// ASSUMPTION: summary and timeline labels (English site). VERIFY: on an order page.
export const LABELS = {
  itemsTotal: /subtotal|items? total|products? total/i,
  shipping: /shipping/i,
  fee: /fee|commission/i,
  total: /^total/i,
  paid: /^paid/i,
  sent: /^(sent|shipped)/i,
  /** Shipping methods named like this have a tracking code. */
  trackedMethod: /track|registered|insured|raccomandata|einschreiben/i,
};

// --- codes -----------------------------------------------------------------------------------------------------------

// ASSUMPTION: the CSV writes conditions with CardTrader's names (as the API's "condition" property). Ledger codes are
// Cardmarket-style grades. VERIFY: the condition column of a real export.
export const CONDITION_TO_CT: Record<string, string> = {
  M: "Mint",
  NM: "Near Mint",
  EX: "Slightly Played",
  GD: "Moderately Played",
  LP: "Played",
  PL: "Heavily Played",
  PO: "Poor",
};
const CONDITION_FROM_CT: Record<string, string> = Object.fromEntries(
  Object.entries(CONDITION_TO_CT).map(([k, v]) => [v.toLowerCase(), k]),
);

export function conditionFromCt(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return CONDITION_FROM_CT[v.toLowerCase()] ?? v.toUpperCase();
}

// ASSUMPTION: languages are CardTrader's codes (as the API's *_language properties). VERIFY: a real export.
export const LANGUAGE_TO_CT: Record<string, string> = {
  EN: "en", IT: "it", DE: "de", FR: "fr", ES: "es", PT: "pt", JP: "jp", KO: "ko", RU: "ru", ZHS: "zh-CN",
};
const LANGUAGE_FROM_CT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(LANGUAGE_TO_CT).map(([k, v]) => [v.toLowerCase(), k])),
  ja: "JP", zh: "ZHS", english: "EN", italian: "IT", german: "DE", french: "FR", spanish: "ES", portuguese: "PT",
  japanese: "JP", korean: "KO", russian: "RU", "simplified chinese": "ZHS",
};

export function languageFromCt(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return LANGUAGE_FROM_CT[v.toLowerCase()] ?? v.toUpperCase();
}

/** ASSUMPTION: boolean columns are "true"/"false" (also accepted: 1/0, yes/no, X). */
export function flag(value: unknown): boolean {
  return value === true || /^(true|1|yes|y|x)$/i.test(String(value ?? "").trim());
}

/** "€12.34", "12,34 €", "1.234,50" -> "12.34" / "1234.50"; null when there is no number. */
export function parseCtMoney(text: string | null | undefined): string | null {
  const raw = (text ?? "").replace(/[^\d.,-]/g, "");
  if (!/\d/.test(raw)) return null;
  const lastSep = Math.max(raw.lastIndexOf(","), raw.lastIndexOf("."));
  const normalized =
    lastSep >= 0 && raw.length - lastSep - 1 <= 2
      ? raw.slice(0, lastSep).replace(/[.,]/g, "") + "." + raw.slice(lastSep + 1)
      : raw.replace(/[.,]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

/** The currency of a money text. ASSUMPTION: the seller's account is in EUR unless another symbol shows. */
export function parseCtCurrency(text: string | null | undefined): string {
  if (/\$|USD/.test(text ?? "")) return "USD";
  if (/£|GBP/.test(text ?? "")) return "GBP";
  return "EUR";
}

// --- inventory export CSV ----------------------------------------------------------------------------------------------

// ASSUMPTION: the inventory export is a ","-separated UTF-8 CSV with a header row (the delimiter is detected anyway),
// one row per product, with these columns (names as the API v2 product fields). Only the columns below are read.
// VERIFY: export the inventory from the seller area and compare its header; check whether the price is in euros
// ("12.34") or cents, and whether user_data_field / description and cardmarket_id are exported.
export const STOCK_COLUMNS = {
  productId: ["id", "product_id", "Product ID"],
  blueprintId: ["blueprint_id", "Blueprint ID"],
  cmProductId: ["cardmarket_id", "card_market_id", "Cardmarket ID"],
  name: ["name_en", "name", "Name"],
  setCode: ["expansion_code", "Expansion Code", "set_code"],
  number: ["collector_number", "Collector Number"],
  condition: ["condition", "Condition"],
  language: ["language", "mtg_language", "Language"],
  foil: ["foil", "mtg_foil", "Foil"],
  quantity: ["quantity", "Quantity"],
  price: ["price", "Price"],
  priceCents: ["price_cents"],
  /** Free field of the product, set by the import to "cardledger:<listing id>" (USER_DATA_PREFIX). */
  tag: ["user_data_field", "User data", "description"],
} as const;

type Column = keyof typeof STOCK_COLUMNS;

function pick(record: Record<string, string>, column: Column): string {
  for (const name of STOCK_COLUMNS[column]) if (name in record) return record[name] ?? "";
  return "";
}

/** A row of the inventory export: the report's stock row plus the product's free field (tag). */
export interface CtStockRow extends StockRow {
  tag: string;
}

const positiveInt = (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Parse an inventory export (rows without a product id are skipped). */
export function parseInventoryCsv(text: string): CtStockRow[] {
  const rows: CtStockRow[] = [];
  for (const r of parseCsvRecords(text, detectDelimiter(text))) {
    const productId = pick(r, "productId").trim();
    if (!productId) continue;
    const cents = pick(r, "priceCents").trim();
    rows.push({
      market_listing_id: productId,
      ct_blueprint_id: positiveInt(pick(r, "blueprintId").trim()),
      cm_product_id: positiveInt(pick(r, "cmProductId").trim()),
      name: pick(r, "name").trim(),
      set_code: pick(r, "setCode").trim().toUpperCase(),
      collector_number: normalizeNumber(pick(r, "number")),
      condition: conditionFromCt(pick(r, "condition")),
      language: languageFromCt(pick(r, "language")),
      foil: flag(pick(r, "foil")),
      quantity: Number.parseInt(pick(r, "quantity"), 10) || 0,
      price: (cents ? fromCents(Number(cents)) : parseCtMoney(pick(r, "price"))) ?? "0.00",
      tag: pick(r, "tag").trim(),
    });
  }
  return rows;
}

/** The report's stock row of an export row (without the tag). */
export function toStockRow({ tag: _tag, ...row }: CtStockRow): StockRow {
  return row;
}

/** Is this download a CSV (and not an HTML page)? */
export function looksLikeCsv(text: string, contentType = ""): boolean {
  if (/csv|octet-stream|text\/plain/i.test(contentType)) return true;
  const head = text.replace(/^﻿/, "").slice(0, 300);
  return !/<html|<!doctype/i.test(head) && /blueprint_id|Blueprint ID/.test(head);
}

// --- inventory import CSV ----------------------------------------------------------------------------------------------

// ASSUMPTION: the import takes a ","-separated CSV with this header.
//   - A row with an `id` (CardTrader product id) updates that product: quantity and price are REPLACED, not added.
//   - A row without `id` creates a product. CardTrader finds its blueprint from the first column it can use:
//     blueprint_id, else cardmarket_id (Cardmarket product id), else game_id + expansion_code + collector_number,
//     else game_id + expansion_code + name.
//   - user_data_field is stored on the product and comes back in the export (it identifies the CardLedger listing).
// VERIFY: the import page's help/template (download its sample file if it offers one); upload a 1-row update of a
// cheap card and check the quantity was replaced; check which identification columns it accepts.
export const IMPORT_HEADER = [
  "id", "blueprint_id", "cardmarket_id", "game_id", "expansion_code", "collector_number", "name",
  "quantity", "price", "condition", "language", "foil", "user_data_field",
];
export const IMPORT_DELIMITER = ",";
/** ASSUMPTION: extra fields the import form must send (e.g. "update existing products" instead of "add"). VERIFY. */
export const IMPORT_OVERRIDES: Record<string, string> = {};
export const USER_DATA_PREFIX = "cardledger:";

// ASSUMPTION: how a removal is expressed. "import-zero": a row with the product id and quantity 0 removes it;
// "product-form": the product's own page has a delete form (SEL.productRemoveForm).
// VERIFY: try a removal through the import on a cheap card; if it is refused or ignored, switch to "product-form".
export const DELETE_STRATEGY: "import-zero" | "product-form" = "import-zero";

export function userDataTag(listingId: number): string {
  return `${USER_DATA_PREFIX}${listingId}`;
}

/** The import CSV row of a plan change. Products (sealed, accessories) have no condition and no foil. */
export function importRow(change: PlanChange): Array<string | number> {
  const item = change.item;
  const remove = change.action === "delete";
  const create = change.action === "create" || !change.market_listing_id;
  return [
    create ? "" : change.market_listing_id,
    create ? (item.ct_blueprint_id ?? "") : "",
    create ? (item.cm_product_id ?? "") : "",
    create ? (CT_GAMES[item.game] ?? "") : "",
    create ? item.set_code.toLowerCase() : "",
    create ? item.collector_number : "",
    create ? item.name : "",
    remove ? 0 : change.quantity,
    Number(change.price).toFixed(2),
    item.is_product ? "" : (CONDITION_TO_CT[item.condition] ?? item.condition),
    LANGUAGE_TO_CT[item.language] ?? item.language.toLowerCase(),
    item.is_product ? "" : item.foil ? "true" : "false",
    userDataTag(change.listing_id),
  ];
}

export function buildImportCsv(changes: PlanChange[]): string {
  return writeCsv(IMPORT_HEADER, changes.map(importRow), IMPORT_DELIMITER);
}

// --- pages -------------------------------------------------------------------------------------------------------------

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The logged-in seller's username, or null (sign-in form, no user menu). */
export function parseUsername(doc: Document): string | null {
  const el = doc.querySelector(SEL.username);
  const name = el?.getAttribute("data-cl-username") || el?.getAttribute("data-username") || text(el);
  return name || null;
}

export function isSignInPage(doc: Document): boolean {
  return !!doc.querySelector(SEL.loginForm) && !parseUsername(doc);
}

export function parseCsrfToken(doc: Document): string | null {
  return doc.querySelector(SEL.csrfToken)?.getAttribute("content") || null;
}

/** First message of a success / error flash on a page after a form post. */
export function parseAlerts(doc: Document): { success: string | null; error: string | null } {
  return {
    success: text(doc.querySelector(SEL.alertSuccess)) || null,
    error: text(doc.querySelector(SEL.alertError)) || null,
  };
}

export function parseExportLink(doc: Document): string | null {
  const href = doc.querySelector(SEL.exportDownload)?.getAttribute("href");
  return href ? new URL(href, ORIGIN).toString() : null;
}

/** Order ids linked from an orders list page, in page order, without duplicates. */
export function parseOrdersList(doc: Document): string[] {
  const ids: string[] = [];
  for (const a of doc.querySelectorAll(SEL.ordersOrderLink)) {
    const m = /\/orders\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute("href") ?? "");
    if (m && !ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}

// --- order page ----------------------------------------------------------------------------------------------------------

/** CardTrader's order states -> CardLedger's (API v2 names; hub_pending is a paid CardTrader Zero order). */
export const CT_STATES: Record<string, OrderState> = {
  paid: "paid",
  hub_pending: "paid",
  request_for_cancel: "paid",
  sent: "sent",
  lost: "sent",
  closed: "sent",
  arrived: "arrived",
  done: "arrived",
  canceled: "canceled",
  cancelled: "canceled",
};

interface CtMoney {
  cents?: number | null;
  currency?: string;
}

/** The order JSON embedded in the page: ASSUMPTION, the API v2 order shape (only these fields are read). */
export interface CtOrderJson {
  id: number | string;
  state?: string;
  buyer?: { username?: string } | null;
  paid_at?: string | null;
  sent_at?: string | null;
  seller_total?: CtMoney | null;
  seller_subtotal?: CtMoney | null;
  seller_fee_amount?: CtMoney | null;
  order_shipping_address?: Record<string, string | null> | null;
  order_shipping_method?: { name?: string; tracked?: boolean; tracking_code?: string | null; seller_price?: CtMoney | null } | null;
  order_items?: Array<{
    id: number | string;
    product_id?: number | string | null;
    blueprint_id?: number | null;
    name?: string;
    expansion?: string | { code?: string; name_en?: string };
    quantity?: number;
    seller_price?: CtMoney | null;
    properties?: Record<string, unknown>;
  }>;
}

const LANGUAGE_SUFFIX = "_language";
const FOIL_SUFFIXES = ["_foil", "_reverse", "_holo"];

function propsLanguage(props: Record<string, unknown>): string {
  const entry = Object.entries(props).find(([k]) => k.endsWith(LANGUAGE_SUFFIX) || k === "language");
  return languageFromCt(String(entry?.[1] ?? ""));
}

function propsFoil(props: Record<string, unknown>): boolean {
  return Object.entries(props).some(([k, v]) => (k === "foil" || FOIL_SUFFIXES.some((s) => k.endsWith(s))) && flag(v));
}

const net = (total: string | null, fee: string | null) =>
  total !== null ? (Number(total) - Number(fee ?? 0)).toFixed(2) : null;

/** Map the embedded order JSON. state: the list it was found on, unless the JSON says otherwise. */
export function orderFromJson(o: CtOrderJson, listState: OrderState): OrderRow {
  const address = o.order_shipping_address ?? {};
  const method = o.order_shipping_method ?? {};
  const total = fromCents(o.seller_total ?? null);
  const fee = fromCents(o.seller_fee_amount ?? null);
  return {
    market_order_id: String(o.id),
    state: CT_STATES[o.state ?? ""] ?? listState,
    buyer_username: o.buyer?.username ?? "",
    buyer_name: address.name ?? "",
    ship_name: address.name ?? "",
    ship_street: address.street ?? "",
    ship_zip: address.zip ?? "",
    ship_city: address.city ?? "",
    ship_province: address.state_or_province ?? "",
    ship_country: address.country ?? "",
    ship_country_code: address.country_code ?? "",
    ship_note: address.note ?? "",
    shipping_method: method.name ?? "",
    tracked: !!method.tracked,
    tracking_code: method.tracking_code ?? "",
    paid_at: o.paid_at ?? null,
    sent_at: o.sent_at ?? null,
    items_total: fromCents(o.seller_subtotal ?? null),
    shipping_cost: fromCents(method.seller_price ?? null),
    market_fee: fee,
    total,
    // ASSUMPTION: seller_total is what the buyer paid the seller; CardTrader's fee is taken from it.
    net: net(total, fee),
    currency: o.seller_total?.currency ?? "EUR",
    items: (o.order_items ?? []).map((i) => {
      const props = i.properties ?? {};
      const expansion = typeof i.expansion === "object" && i.expansion ? (i.expansion.code ?? i.expansion.name_en ?? "") : (i.expansion ?? "");
      return {
        market_item_id: String(i.id),
        market_listing_id: i.product_id ? String(i.product_id) : undefined,
        name: i.name ?? "",
        expansion: String(expansion),
        condition: conditionFromCt(String(props.condition ?? "")),
        language: propsLanguage(props),
        foil: propsFoil(props),
        quantity: i.quantity ?? 1,
        price: fromCents(i.seller_price ?? null),
      };
    }),
  };
}

function embeddedOrder(doc: Document): CtOrderJson | null {
  const el = doc.querySelector(SEL.order.json);
  if (!el) return null;
  const raw = el.getAttribute("data-order") ?? el.textContent ?? "";
  try {
    const data = JSON.parse(raw) as CtOrderJson | { order?: CtOrderJson };
    const order = "order" in data && data.order ? data.order : (data as CtOrderJson);
    return order && order.id !== undefined ? order : null;
  } catch {
    return null;
  }
}

// ASSUMPTION (DOM fallback): item rows carry data-* attributes: data-item-id, data-product-id, data-name,
// data-expansion, data-condition (CardTrader name), data-language (code), data-foil ("true"/"false"),
// data-quantity, data-price ("€1.50"). VERIFY: inspect an item row of a real order.
function itemRow(row: Element, orderId: string, index: number): OrderItemRow {
  const attr = (n: string) => row.getAttribute(`data-${n}`) ?? "";
  const productId = attr("product-id");
  return {
    market_item_id: attr("item-id") || `${orderId}-${index + 1}`,
    market_listing_id: productId || undefined,
    name: attr("name") || text(row.querySelector(".name")),
    expansion: attr("expansion"),
    condition: conditionFromCt(attr("condition")),
    language: languageFromCt(attr("language")),
    foil: flag(attr("foil")),
    quantity: Number.parseInt(attr("quantity"), 10) || 1,
    price: parseCtMoney(attr("price")),
  };
}

function orderFromDom(doc: Document, orderId: string, state: OrderState): OrderRow {
  const o = SEL.order;
  const address = doc.querySelector(o.address);
  const part = (sel: string) => text(address?.querySelector(sel));
  const method = text(doc.querySelector(o.shippingMethod));

  const dates: { paid: string | null; sent: string | null } = { paid: null, sent: null };
  for (const row of doc.querySelectorAll(o.timelineRow)) {
    const label = text(row.querySelector(".label"));
    const date = row.querySelector("time")?.getAttribute("datetime") || null;
    if (LABELS.paid.test(label)) dates.paid = date;
    else if (LABELS.sent.test(label)) dates.sent = date;
  }
  const sums = { items: null as string | null, shipping: null as string | null, fee: null as string | null, total: null as string | null, currency: "EUR" };
  for (const row of doc.querySelectorAll(o.summaryRow)) {
    const label = text(row.querySelector(".label"));
    const valueText = text(row.querySelector(".value"));
    const value = parseCtMoney(valueText);
    if (LABELS.total.test(label)) {
      sums.total = value;
      sums.currency = parseCtCurrency(valueText);
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
    ship_street: part(o.addressStreet),
    ship_zip: part(o.addressZip),
    ship_city: part(o.addressCity),
    ship_province: part(o.addressProvince),
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
    net: net(sums.total, sums.fee),
    currency: sums.currency,
    items: [...doc.querySelectorAll(o.itemRow)].map((row, i) => itemRow(row, orderId, i)),
  };
}

/** Parse an order page: the embedded order JSON if there is one, else the HTML. */
export function parseOrderPage(doc: Document, orderId: string, state: OrderState): OrderRow {
  const json = embeddedOrder(doc);
  return json ? orderFromJson(json, state) : orderFromDom(doc, orderId, state);
}
