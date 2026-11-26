// =====================================================================================================================
// CARDMARKET FORMATS — everything about cardmarket.com lives in this module, and nowhere else.
//
// Cardmarket has no API we may use, so the extension drives the seller's own pages, in a cardmarket.com tab, with the
// seller's session. A private account has no stock CSV export/import, so the stock is read from "My Offers"
// (/Stock/Offers/<category>, paginated), an article is listed with the product page's sell form, edited with the
// "Edit article" modal and its quantity changed (or removed) with the offers page's +/- AJAX action. Orders are read
// from the sales pages and shipped with the "mark as sent" form.
//
// Blocks marked VERIFIED were checked on the real site (date given); their fixtures in test/fixtures/cardmarket/ are
// real (redacted) pages. Blocks marked ASSUMPTION still are guesses: VERIFY says what to look at. When correcting one,
// replace its fixture with the real page first, then fix until the tests pass.
// =====================================================================================================================

import type { OrderItemRow, OrderRow, OrderState, StockRow } from "../../types";

// --- site, pacing -------------------------------------------------------------------------------------------------

export const ORIGIN = "https://www.cardmarket.com";
/** Language segment of every URL; the page texts matched below are the English ones. */
export const SITE_LANGUAGE = "en";
/** Minimum pause between two requests to cardmarket.com (the rule is ≥ 1 s; a bit more to look human). */
export const MIN_REQUEST_GAP_MS = 1500;
/** At most this many pages of each offers category are read per run. */
export const MAX_OFFER_PAGES = 50;
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

// VERIFIED (2026-11-26): stock, product and sales URLs. ASSUMPTION: the order page URL (no order yet to check).
export const URLS = {
  home: () => `${ORIGIN}/${SITE_LANGUAGE}/Magic`,
  /** "My Offers": one box per category with offers (Singles, ...), linking to offersCategory. */
  offers: (game: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Stock/Offers`,
  /** One category of the seller's offers ("Singles"), paginated with ?site=N (1-based). */
  offersCategory: (game: string, category: string, page = 1) =>
    `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Stock/Offers/${encodeURIComponent(category)}${page > 1 ? `?site=${page}` : ""}`,
  /** Redirects to the product page (which has the sell form). */
  product: (game: string, productId: number) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Products?idProduct=${productId}`,
  /** The "Edit article" modal of one of the seller's articles. */
  editModal: (game: string, articleId: string) =>
    `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Modal/Article_EditArticleModal?showUserOffersRow=1&table=userOffers&idArticle=${encodeURIComponent(articleId)}`,
  /** AJAX actions: a form's data-ajax-action is posted to /AjaxAction/<action>; the +/- buttons post `args` to /AjaxAction. */
  ajax: (game: string, action?: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/AjaxAction${action ? `/${action}` : ""}`,
  /** Sales by state, paginated with ?site=N (1-based). */
  sales: (game: string, state: "Paid" | "Sent", page = 1) =>
    `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Orders/Sales/${state}${page > 1 ? `?site=${page}` : ""}`,
  order: (game: string, orderId: string) => `${ORIGIN}/${SITE_LANGUAGE}/${gamePath(game)}/Orders/${orderId}`,
};

// --- selectors -------------------------------------------------------------------------------------------------------

// ASSUMPTION: these CSS selectors find the parts of the pages. Several alternatives are tried in order (comma lists
// are standard CSS). VERIFY: in DevTools (Elements panel) on each page.
export const SEL = {
  /** Present only when logged in; its text is the seller's username. VERIFIED (2026-11-26, header of /it/Magic):
   * a#account-dropdown > div.line-height115 > span (username), span#totalCreditMainNav (credit). */
  username: "#account-dropdown .line-height115 > span:not(#totalCreditMainNav)",
  /** Present on the login form (logged out). */
  loginForm: "form[action*='PostGetAction/User_Login'], form#loginForm",
  /** VERIFIED (2026-11-26): the system message after a form post ("Your item(s) have been listed!"). */
  alertSuccess: ".alert-success",
  alertError: ".alert-danger, .alert-warning",
  /** VERIFIED (2026-11-26): "My Offers" and its category pages. */
  offers: {
    /** Category boxes on /Stock/Offers. */
    categoryLink: "a.galleryBox[href*='/Stock/Offers/']",
    /** One row per article; its id is "stockRow<idArticle>". */
    row: ".article-row[id^='stockRow']",
    name: ".col-seller a",
    /** data-bs-title holds an <img> whose src is .../<game>/<set code>/<idProduct>/<idProduct>.jpg */
    thumbnail: ".col-thumbnail [data-bs-title]",
    /** Badge with the condition code ("NM"). */
    condition: ".article-condition .badge",
    /** Icons with a title: expansion, rarity, condition, language ("English"), foil. */
    attributes: ".product-attributes [title]",
    price: ".price-container",
    amount: ".amount-container .item-count",
    /** The +/- quantity buttons: onclick="jcp('<args prefix>'+Base64.encode(''+JSON.stringify({...})),...)". */
    amountButton: ".inc-dec-group button[onclick*='jcp(']",
  },
  /** VERIFIED (2026-11-26): the sell form of a product page (POST, regular page answer with a system message). */
  listForm: "form#ListProductForm",
  /** VERIFIED (2026-11-26): the form of the "Edit article" modal (posted to URLS.ajax(game, data-ajax-action)). */
  editForm: "form[data-ajax-action]",
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

// VERIFIED (2026-11-26): the sell and edit forms take these language ids (idLanguage), and the offers rows name the
// language ("English", "S-Chinese", "T-Chinese").
export const LANGUAGE_IDS: Record<string, number> = {
  EN: 1, FR: 2, DE: 3, ES: 4, IT: 5, ZHS: 6, JP: 7, PT: 8, RU: 9, KO: 10, ZHT: 11,
};
const LANGUAGE_NAMES: Record<string, string> = {
  english: "EN", french: "FR", german: "DE", spanish: "ES", italian: "IT", "s-chinese": "ZHS",
  "simplified chinese": "ZHS", japanese: "JP", portuguese: "PT", russian: "RU", korean: "KO", "t-chinese": "ZHT",
};

export function languageFromCm(value: string): string {
  const v = value.trim();
  const byId = Object.entries(LANGUAGE_IDS).find(([, id]) => String(id) === v);
  if (byId) return byId[0];
  return LANGUAGE_NAMES[v.toLowerCase()] ?? v.toUpperCase();
}

// VERIFIED (2026-11-26): conditions are Cardmarket's grade codes (offers badge, edit form's "condition"); the Ledger uses
// the same ones except Mint ("M" vs "MT"). The sell form takes ids instead (idCondition: 1 Mint ... 7 Poor).
export const CONDITION_TO_CM: Record<string, string> = { M: "MT", NM: "NM", EX: "EX", GD: "GD", LP: "LP", PL: "PL", PO: "PO" };
export const CONDITION_IDS: Record<string, number> = { M: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };
const CONDITION_NAMES: Record<string, string> = {
  mint: "M", "near mint": "NM", excellent: "EX", good: "GD", "light played": "LP", played: "PL", poor: "PO",
};

export function conditionFromCm(value: string): string {
  const v = value.trim();
  const byCode = Object.entries(CONDITION_TO_CM).find(([, cm]) => cm === v.toUpperCase());
  if (byCode) return byCode[0];
  return CONDITION_NAMES[v.toLowerCase()] ?? v.toUpperCase();
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

/** ASSUMPTION: boolean markers are "X" (or "1"/"true"/"yes") when set. */
function flag(value: string | undefined): boolean {
  return /^(x|1|true|yes|y)$/i.test((value ?? "").trim());
}

// --- my offers -------------------------------------------------------------------------------------------------------

/** The categories with offers on /Stock/Offers ("Singles", ...), as the last path segment of their links. */
export function parseOffersCategories(doc: Document): string[] {
  const out: string[] = [];
  for (const a of doc.querySelectorAll<HTMLAnchorElement>(SEL.offers.categoryLink)) {
    const m = /\/Stock\/Offers\/([^/?#]+)/.exec(a.getAttribute("href") ?? "");
    const category = m ? decodeURIComponent(m[1]!) : "";
    if (category && !out.includes(category)) out.push(category);
  }
  return out;
}

/** "Page 2 of 5" on a paginated list: the current and last page (1 and 1 when absent). */
export function parsePagination(doc: Document): { page: number; pages: number } {
  const m = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(doc.body?.textContent ?? "");
  return m ? { page: Number(m[1]), pages: Number(m[2]) } : { page: 1, pages: 1 };
}

/** The language of an offers row from its icons' titles ("English"), or "". */
function rowLanguage(titles: string[]): string {
  for (const t of titles) {
    const code = languageFromCm(t);
    if (code in LANGUAGE_IDS) return code;
  }
  return "";
}

/** The seller's articles on one page of a "My Offers" category. */
export function parseOffersPage(doc: Document): StockRow[] {
  const rows: StockRow[] = [];
  for (const el of doc.querySelectorAll(SEL.offers.row)) {
    const articleId = el.id.replace(/^stockRow/, "");
    if (!/^\d+$/.test(articleId)) continue;
    const image = el.querySelector(SEL.offers.thumbnail)?.getAttribute("data-bs-title") ?? "";
    // .../1/DOM/319744/319744.jpg: game, set code, product id
    const img = /\/\d+\/([^/]+)\/(\d+)\/[^/"]+\.(?:jpg|jpeg|png|webp)/i.exec(image);
    const titles = [...el.querySelectorAll(SEL.offers.attributes)].map((a) => a.getAttribute("title") ?? "");
    rows.push({
      market_listing_id: articleId,
      cm_product_id: img ? Number(img[2]) : null,
      name: text(el.querySelector(SEL.offers.name)),
      set_code: img ? img[1]!.toUpperCase() : "",
      collector_number: "",
      condition: conditionFromCm(text(el.querySelector(SEL.offers.condition))),
      language: rowLanguage(titles),
      // ASSUMPTION (no foil article seen yet): a foil article has an icon titled "Foil". VERIFY on a foil offer.
      foil: titles.some((t) => /^foil$/i.test(t.trim())),
      quantity: Number.parseInt(text(el.querySelector(SEL.offers.amount)), 10) || 0,
      price: parseCmMoney(text(el.querySelector(SEL.offers.price))) ?? "0.00",
    });
  }
  return rows;
}

/**
 * The opaque first argument of the +/- buttons' jcp() call on an offers page (it names the AJAX action; the JSON
 * arguments follow it, base64). The same for every row and for + and -. Null when the page has no such button.
 */
export function parseAmountArgsPrefix(html: string): string | null {
  const m = /jcp\('([^']+)'\s*\+\s*Base64\.encode\(\s*''\s*\+\s*JSON\.stringify\(\s*\{\s*'showUserOffersRow'/.exec(html);
  return m ? m[1]! : null;
}

/** The `args` field posted to URLS.ajax(game) to add (delta > 0) or remove (delta < 0) copies of an article. */
export function amountArgs(prefix: string, articleId: string, delta: number): string {
  const json = JSON.stringify({ showUserOffersRow: "1", sign: delta < 0 ? "-1" : "1", idArticle: articleId, amount: String(Math.abs(delta)) });
  return prefix + btoa(json);
}

const decodeBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)));

/**
 * An AJAX action's XML answer (<ajaxResponse>, base64 values). VERIFIED (2026-11-26): an edit answers resultType
 * "success" with a systemMessage; a quantity change answers the new row (idRow, articleRow) without resultType, and an
 * empty articleRow when the last copy was removed.
 * ASSUMPTION: a refusal answers resultType "error" (or "warning") with its systemMessage.
 */
export function parseAjaxResponse(xml: string): { ok: boolean; message: string | null } {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (!doc.querySelector("ajaxResponse")) return { ok: false, message: "Cardmarket gave no AJAX answer (logged out?)." };
  const field = (name: string) => {
    const raw = doc.querySelector(`ajaxResponse > ${name}`)?.textContent ?? "";
    if (!raw) return "";
    try {
      return decodeBase64(raw);
    } catch {
      return raw;
    }
  };
  const type = field("resultType");
  const message = field("systemMessage");
  const messageText = message ? text(new DOMParser().parseFromString(message, "text/html").body) || null : null;
  return { ok: !type || type === "success", message: messageText };
}

/** Fields of the sell form (ListProductForm) for one article. Foil is a checkbox: only sent when set. */
export function listFields(a: { quantity: number; price: string | number; language: string; condition: string; foil: boolean; comment: string }): Record<string, string> {
  const language = LANGUAGE_IDS[a.language];
  const condition = CONDITION_IDS[a.condition];
  if (!language) throw new Error(`Language "${a.language}" is not known on Cardmarket.`);
  if (!condition) throw new Error(`Condition "${a.condition}" is not known on Cardmarket.`);
  return {
    amount: String(a.quantity),
    idLanguage: String(language),
    idCondition: String(condition),
    price: cmPrice(a.price),
    comments: a.comment ?? "",
    ...(a.foil ? { isFoil: "X" } : {}),
  };
}

/** Fields of the "Edit article" form for all `copies` copies of an article. */
export function editFields(a: { copies: number; price: string | number; language: string; condition: string; foil: boolean; comment: string }): Record<string, string> {
  const language = LANGUAGE_IDS[a.language];
  const condition = CONDITION_TO_CM[a.condition];
  if (!language) throw new Error(`Language "${a.language}" is not known on Cardmarket.`);
  if (!condition) throw new Error(`Condition "${a.condition}" is not known on Cardmarket.`);
  return {
    condition,
    idLanguage: String(language),
    price: cmPrice(a.price),
    comments: a.comment ?? "",
    editAmount: String(a.copies),
    ...(a.foil ? { isFoil: "on" } : {}),
  };
}

/** A price as the forms take it ("98,50"; VERIFIED with a comma). */
export function cmPrice(price: string | number): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid price "${price}".`);
  return n.toFixed(2).replace(".", ",");
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

// ASSUMPTION: Cardmarket's forms are plain HTML forms posted to their action with the session cookie (the generic
// helpers live in lib/forms.ts).
export { formAction, formData } from "../../lib/forms";
