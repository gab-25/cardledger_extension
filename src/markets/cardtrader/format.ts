// =====================================================================================================================
// CARDTRADER FORMATS — everything about www.cardtrader.com lives in this module, and nowhere else.
//
// No API token: the extension drives the seller's own pages in a logged-in www.cardtrader.com tab, with the seller's
// session, and calls the same-origin JSON endpoints those pages use. It reads the inventory from "My items"
// (/users/<slug>.json, paginated), creates products with "Sell via spreadsheet" (upload a CSV, map its columns, start
// the import, wait for it to end), edits and deletes a product with the JSON calls of the "My items" edit panel, reads
// the seller's orders and marks an order shipped on the order page.
//
// Blocks marked VERIFIED were checked on the real site (date given); their fixtures in test/fixtures/cardtrader/ are
// real (redacted) answers. Blocks marked ASSUMPTION still are guesses (the orders: no order seen yet): VERIFY says
// what to look at. When correcting one, replace its fixture with the real answer first, then fix until tests pass.
// =====================================================================================================================

import { writeCsv } from "../../lib/csv";
import { fromCents, normalizeNumber } from "../../lib/util";
import type { OrderItemRow, OrderRow, OrderState, PlanChange, StockRow } from "../../types";

// --- site, pacing -------------------------------------------------------------------------------------------------

export const ORIGIN = "https://www.cardtrader.com";
/** VERIFIED (2026-11-26): locale segment of every URL ("/en" redirects to "/en-EU"); page texts are the English ones. */
export const SITE_LANGUAGE = "en-EU";
/** Minimum pause between two requests to cardtrader.com (≥ 1.5 s, like Cardmarket). */
export const MIN_REQUEST_GAP_MS = 1500;
/** An import is processed in the background (VERIFIED: a few seconds for one row): poll its page this often. */
export const IMPORT_POLL_ATTEMPTS = 20;
export const IMPORT_POLL_GAP_MS = 3000;
/**
 * VERIFIED (2026-11-26): "My items" (/users/<slug>.json) is a search index that shows edits and deletes a few seconds
 * late; /products/<id>.json is current. After changing things, the inventory is read again after this pause, and the
 * products touched are read one by one.
 */
export const INDEX_SETTLE_MS = 5000;
/** At most this many pages of the inventory are read per run. */
export const MAX_INVENTORY_PAGES = 100;
/** At most this many pages of each orders list are read per run. */
export const MAX_ORDER_PAGES = 5;

// VERIFIED (2026-11-26): inventory, import and product URLs. ASSUMPTION: the orders and order URLs (no order seen yet).
export const URLS = {
  home: () => `${ORIGIN}/${SITE_LANGUAGE}`,
  /** "My items" as JSON: {products, products_last_page_reached, ...}, ?page=N (1-based). */
  inventory: (slug: string, page = 1) => `${ORIGIN}/${SITE_LANGUAGE}/users/${encodeURIComponent(slug)}.json?page=${page}`,
  /** One of the seller's products as JSON ({product, blueprint}); the only answer carrying user_data_field. */
  productJson: (productId: string) => `${ORIGIN}/${SITE_LANGUAGE}/products/${encodeURIComponent(productId)}.json`,
  /** PATCH {authenticity_token, product: {...}} edits a product, DELETE removes it (X-CSRF-Token header). */
  productEdit: (blueprintId: number, productId: string) =>
    `${ORIGIN}/${SITE_LANGUAGE}/cards/${blueprintId}/${encodeURIComponent(productId)}.json`,
  /** "Sell via spreadsheet": the upload form; the upload answers a draft to map (/product_imports/<id>/edit). */
  importNew: () => `${ORIGIN}/${SITE_LANGUAGE}/product_imports/new`,
  /** An import's page: "We are processing your file" until it ends, then its summary. */
  importStatus: (importId: string) => `${ORIGIN}/${SITE_LANGUAGE}/product_imports/${encodeURIComponent(importId)}`,
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

// VERIFIED (2026-11-26): CardTrader's game ids (the import's "Which game are your importing?" options). An import is
// for one game; CardLedger slugs not listed here can't be created on CardTrader.
export const CT_GAMES: Record<string, number> = {
  mtg: 1,
  yugioh: 4,
  pokemon: 5,
  fab: 6,
  digimon: 8,
  dbs: 9,
  vanguard: 10,
  onepiece: 15,
  lorcana: 18,
  swu: 20,
  unionarena: 21,
  riftbound: 22,
  gundam: 23,
  sorcery: 24,
};

// --- selectors -------------------------------------------------------------------------------------------------------

// ASSUMPTION: these CSS selectors find the parts of the pages; comma lists are tried as standard CSS.
// VERIFY: in DevTools (Elements panel) on each page.
export const SEL = {
  /** VERIFIED (2026-11-26): the profile menu's "My items" link, /en-EU/users/<slug>, only when logged in. */
  myItems: ".dropdown-menu[aria-labelledby='profile-dropdown'] a[href*='/users/']",
  /** Devise's sign-in form (logged out). */
  loginForm: "form[action*='/users/sign_in'], form#new_user",
  /** Rails' anti-CSRF token, sent as X-CSRF-Token by the site's own JSON requests. */
  csrfToken: "meta[name='csrf-token']",
  /** VERIFIED (2026-11-26): the upload form of "Sell via spreadsheet" (file field product_import[csv]). */
  importUploadForm: "form#form-text-modal",
  importFile: "input[type='file'][name='product_import[csv]']",
  /** VERIFIED (2026-11-26): the draft's mapping form (PATCH /product_imports/<id>). */
  importMapForm: "form[action*='/product_imports/']",
  /** Rails flash messages. */
  alertSuccess: ".alert-success, .flash-notice",
  alertError: ".alert-danger, .alert-error, .flash-alert",
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

// VERIFIED (2026-11-26): CardTrader's conditions are these six names (the "My items" filter; a product's
// properties_hash.condition, the edit's prop_condition). Ledger codes are Cardmarket-style grades: Cardmarket's
// Played and Poor have no separate CardTrader grade below "Played", so PL maps to "Played" too.
export const CONDITION_TO_CT: Record<string, string> = {
  M: "Mint",
  NM: "Near Mint",
  EX: "Slightly Played",
  GD: "Moderately Played",
  LP: "Played",
  PL: "Played",
  PO: "Poor",
};
const CONDITION_FROM_CT: Record<string, string> = {
  mint: "M", "near mint": "NM", "slightly played": "EX", "moderately played": "GD", played: "LP", "heavily played": "PL", poor: "PO",
};

export function conditionFromCt(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return CONDITION_FROM_CT[v.toLowerCase()] ?? v.toUpperCase();
}

// VERIFIED (2026-11-26): languages are CardTrader's codes (the "My items" filter, properties_hash.<game>_language).
export const LANGUAGE_TO_CT: Record<string, string> = {
  EN: "en", IT: "it", DE: "de", FR: "fr", ES: "es", PT: "pt", JP: "jp", KO: "kr", RU: "ru", ZHS: "zh-CN", ZHT: "zh-TW",
};
const LANGUAGE_FROM_CT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(LANGUAGE_TO_CT).map(([k, v]) => [v.toLowerCase(), k])),
  ja: "JP", ko: "KO", zh: "ZHS", english: "EN", italian: "IT", german: "DE", french: "FR", spanish: "ES", portuguese: "PT",
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

// --- inventory (JSON) -------------------------------------------------------------------------------------------------

/** VERIFIED (2026-11-26): a product as /users/<slug>.json and /products/<id>.json give it (the fields read here). */
export interface CtProductJson {
  id: number;
  price_cents: number;
  quantity: number;
  description?: string | null;
  tag?: string | null;
  /** Only in /products/<id>.json. */
  user_data_field?: string | null;
  game_id?: number;
  blueprint_id: number;
  name_en?: string;
  name?: string;
  expansion?: { code?: string | null } | null;
  /** condition, <game>_language, <game>_foil, collector_number, signed, altered... (no condition on sealed products). */
  properties_hash?: Record<string, unknown> | null;
}

/** A product of the inventory: the report's stock row plus its user_data_field (tag, when known) and edit details. */
export interface CtStockRow extends StockRow {
  tag: string;
}

/** The property of a product's properties_hash ending with `suffix` ("_language" -> "mtg_language"), if any. */
export function gameProperty(props: Record<string, unknown> | null | undefined, suffix: string): string | null {
  return Object.keys(props ?? {}).find((k) => k.endsWith(suffix)) ?? null;
}

export function toCtStockRow(p: CtProductJson): CtStockRow {
  const props = p.properties_hash ?? {};
  const language = gameProperty(props, "_language");
  const foil = gameProperty(props, "_foil");
  return {
    market_listing_id: String(p.id),
    ct_blueprint_id: p.blueprint_id || null,
    cm_product_id: null,
    name: (p.name_en ?? p.name ?? "").trim(),
    set_code: (p.expansion?.code ?? "").trim().toUpperCase(),
    collector_number: normalizeNumber(String(props["collector_number"] ?? "")),
    condition: props["condition"] ? conditionFromCt(String(props["condition"])) : "",
    language: language ? languageFromCt(String(props[language])) : "",
    foil: foil ? flag(props[foil]) : false,
    quantity: p.quantity,
    price: fromCents(p.price_cents) ?? "0.00",
    tag: (p.user_data_field ?? "").trim(),
  };
}

/** One page of /users/<slug>.json: its products, and whether it was the last one. */
export function parseInventoryPage(json: unknown): { rows: CtStockRow[]; last: boolean } {
  const data = json as { products?: CtProductJson[]; products_last_page_reached?: boolean } | null;
  if (!data || !Array.isArray(data.products)) throw new Error("CardTrader's inventory answer has no products.");
  return { rows: data.products.map(toCtStockRow), last: data.products_last_page_reached !== false || !data.products.length };
}

/** The report's stock row of an inventory row (without the tag). */
export function toStockRow({ tag: _tag, ...row }: CtStockRow): StockRow {
  return row;
}

/**
 * VERIFIED (2026-11-26): the body of PATCH URLS.productEdit — the edit panel sends every field. Properties are named
 * after the product's own ones (prop_<name>), so the game prefix (mtg_language...) comes from the product read first.
 */
export function editBody(
  current: CtProductJson,
  change: { quantity: number; price: string | number; condition: string; language: string; foil: boolean; comment: string; isProduct: boolean },
  token: string,
): Record<string, unknown> {
  const props = current.properties_hash ?? {};
  const product: Record<string, unknown> = {
    graded: false,
    description: change.comment ?? "",
    tag: current.tag ?? "",
    quantity: change.quantity,
    price: ctPrice(change.price),
  };
  if (!change.isProduct && "condition" in props) product["prop_condition"] = CONDITION_TO_CT[change.condition] ?? change.condition;
  const language = gameProperty(props, "_language");
  if (language) product[`prop_${language}`] = LANGUAGE_TO_CT[change.language] ?? change.language.toLowerCase();
  const foil = gameProperty(props, "_foil");
  if (foil && !change.isProduct) product[`prop_${foil}`] = String(change.foil);
  for (const k of ["signed", "altered"]) if (k in props) product[`prop_${k}`] = String(flag(props[k]));
  return { authenticity_token: token, product };
}

/** A price as CardTrader's forms take it ("98.50"; VERIFIED). */
export function ctPrice(price: string | number): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid price "${price}".`);
  return n.toFixed(2);
}

// --- import ("Sell via spreadsheet") ---------------------------------------------------------------------------------

// VERIFIED (2026-11-26): the import takes a CSV file (pasted text is not split into columns), shows it as a draft whose
// columns must be named (product_import[csv_column_names][], values below), for one game (product_import[game_id]),
// adding to the inventory (product_import[replace_stock]=false — NEVER true: that deletes the game's inventory).
// A header row made of the column values is recognised and skipped. A product is found by mkm_id (Cardmarket product
// id) or blueprint_id; user_data_field is stored on the product ("cardledger:<listing id>").
// ASSUMPTION: rows identified only by expansion_code + collector_number / name are found as well; conditions are
// accepted as CardTrader's names ("NM" was verified, "Near Mint" is what the site shows).
export const IMPORT_COLUMNS = [
  "blueprint_id", "mkm_id", "expansion_code", "collector_number", "name",
  "quantity", "price", "condition", "language", "foil", "user_data_field",
] as const;
export const IMPORT_DELIMITER = ",";
export const USER_DATA_PREFIX = "cardledger:";

export function userDataTag(listingId: number): string {
  return `${USER_DATA_PREFIX}${listingId}`;
}

/** The import CSV row of a create. Products (sealed, accessories) have no condition and no foil. */
export function importRow(change: PlanChange): Array<string | number> {
  const item = change.item;
  return [
    item.ct_blueprint_id ?? "",
    item.cm_product_id ?? "",
    item.set_code.toLowerCase(),
    item.collector_number,
    item.name,
    change.quantity,
    ctPrice(change.price),
    item.is_product ? "" : (CONDITION_TO_CT[item.condition] ?? item.condition),
    LANGUAGE_TO_CT[item.language] ?? item.language.toLowerCase(),
    item.is_product ? "" : item.foil ? "true" : "false",
    userDataTag(change.listing_id),
  ];
}

/** The import CSV of creates (one game), with its header row. */
export function buildImportCsv(changes: PlanChange[]): string {
  return writeCsv([...IMPORT_COLUMNS], changes.map(importRow), IMPORT_DELIMITER);
}

/**
 * An import's page: still processing, or its summary (VERIFIED: "1 rows from file", "0 rows with errors",
 * "1 items created", "0 items updates", "0 items cancelled").
 */
export function parseImportStatus(doc: Document): { done: boolean; rows: number; errors: number; warnings: number; created: number; message: string } {
  const body = (doc.body?.textContent ?? "").replace(/\s+/g, " ");
  const count = (re: RegExp) => Number(re.exec(body)?.[1] ?? 0);
  const done = !/We are processing your file/i.test(body);
  const summary = {
    rows: count(/(\d+) rows from file/i),
    warnings: count(/(\d+) rows with warnings/i),
    errors: count(/(\d+) rows with errors/i),
    created: count(/(\d+) items created/i),
  };
  return { done, ...summary, message: `${summary.rows} rows, ${summary.errors} with errors, ${summary.warnings} with warnings, ${summary.created} items created` };
}

// --- pages -------------------------------------------------------------------------------------------------------------

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The logged-in seller's slug (from the profile menu's "My items" link), or null when logged out. */
export function parseUsername(doc: Document): string | null {
  const href = doc.querySelector(SEL.myItems)?.getAttribute("href") ?? "";
  const m = /\/users\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]!) : null;
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
