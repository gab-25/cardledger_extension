// The Cardmarket agent: injected into a cardmarket.com tab (chrome.scripting.executeScript, isolated world), where its
// requests are same-origin and carry the seller's session cookies — the extension never sees or stores credentials.
// It only does page work (fetch, parse with DOMParser, post forms): the background (adapter.ts) decides what to do.
// Every request waits MIN_REQUEST_GAP_MS after the previous one, so the site is never hammered.

import { errorText, sleep } from "../../lib/util";
import type { OrderRow, StockRow } from "../../types";
import {
  MAX_OFFER_PAGES,
  MAX_ORDER_PAGES,
  MIN_REQUEST_GAP_MS,
  SEL,
  URLS,
  amountArgs,
  editFields,
  formAction,
  formData,
  listFields,
  parseAjaxResponse,
  parseAlerts,
  parseAmountArgsPrefix,
  parseOffersCategories,
  parseOffersPage,
  parseOrderPage,
  parsePagination,
  parseSalesList,
  parseUsername,
} from "./format";

/** What an article is listed or edited with (CardLedger codes). */
export interface ArticleFields {
  price: string | number;
  language: string;
  condition: string;
  foil: boolean;
  comment: string;
}

export type AgentRequest =
  | { cmd: "whoami" }
  | { cmd: "readStock"; game: string }
  | ({ cmd: "listArticle"; game: string; productId: number; quantity: number } & ArticleFields)
  | ({ cmd: "editArticle"; game: string; articleId: string; copies: number } & ArticleFields)
  | { cmd: "changeAmount"; game: string; articleId: string; delta: number }
  | { cmd: "listOrders"; game: string; state: "Paid" | "Sent"; maxPages?: number }
  | { cmd: "readOrder"; game: string; orderId: string; state: "paid" | "sent" }
  | { cmd: "markShipped"; game: string; orderId: string; trackingCode: string };

export type AgentResponse<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export interface AgentDeps {
  fetch: typeof fetch;
  document: Document;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class Agent {
  private lastRequest = 0;

  constructor(private readonly deps: AgentDeps) {}

  /** fetch, at least MIN_REQUEST_GAP_MS after the previous request. */
  private async paced(url: string, init: RequestInit = {}): Promise<Response> {
    const wait = this.lastRequest + MIN_REQUEST_GAP_MS - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait);
    try {
      return await this.deps.fetch(url, { credentials: "same-origin", redirect: "follow", ...init });
    } finally {
      this.lastRequest = this.deps.now();
    }
  }

  private async page(url: string, init?: RequestInit): Promise<{ doc: Document; url: string; text: string; type: string }> {
    const resp = await this.paced(url, init);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Cardmarket answered ${resp.status} for ${url}`);
    const doc = new DOMParser().parseFromString(text, "text/html");
    if (doc.querySelector(SEL.loginForm) && !parseUsername(doc)) {
      throw new Error("Not logged in to Cardmarket: log in in this tab and sync again.");
    }
    return { doc, url: resp.url || url, text, type: resp.headers.get("content-type") ?? "" };
  }

  private form(doc: Document, selector: string, what: string, url: string): HTMLFormElement {
    const form = doc.querySelector<HTMLFormElement>(selector);
    if (!form) throw new Error(`${what} form not found on ${url} (selector in cardmarket/format.ts: ${selector}).`);
    return form;
  }

  private async post(form: HTMLFormElement, pageUrl: string, overrides: Record<string, string | Blob> = {}) {
    return this.page(formAction(form, pageUrl), { method: "POST", body: formData(form, overrides) });
  }

  whoami(): { username: string | null } {
    return { username: parseUsername(this.deps.document) };
  }

  /** Every article of the game's "My Offers", category by category, page by page. */
  async readStock(game: string): Promise<StockRow[]> {
    const index = await this.page(URLS.offers(game));
    const rows: StockRow[] = [];
    for (const category of parseOffersCategories(index.doc)) {
      for (let page = 1; page <= MAX_OFFER_PAGES; page++) {
        const current = await this.page(URLS.offersCategory(game, category, page));
        this.rememberAmountPrefix(game, current.text);
        const found = parseOffersPage(current.doc).filter((r) => !rows.some((o) => o.market_listing_id === r.market_listing_id));
        rows.push(...found);
        if (!found.length || page >= parsePagination(current.doc).pages) break;
      }
    }
    return rows;
  }

  /** Put a product on sale with the sell form of its page. */
  async listArticle(game: string, productId: number, quantity: number, fields: ArticleFields): Promise<{ message: string | null }> {
    const url = URLS.product(game, productId);
    const start = await this.page(url);
    const form = this.form(start.doc, SEL.listForm, "Sell", url);
    const data = formData(form);
    for (const name of ["isFoil", "isSigned", "isAltered", "saveSettings"]) data.delete(name);
    for (const [k, v] of Object.entries(listFields({ ...fields, quantity }))) data.set(k, v);
    const result = await this.page(formAction(form, start.url), { method: "POST", body: data });
    const alerts = parseAlerts(result.doc);
    if (!alerts.success) throw new Error(`Cardmarket did not list product ${productId}: ${alerts.error ?? "no confirmation"}`);
    return { message: alerts.success };
  }

  /** Change price, condition, language, foil and comment of all `copies` copies of an article (the edit modal). */
  async editArticle(game: string, articleId: string, copies: number, fields: ArticleFields): Promise<{ message: string | null }> {
    const url = URLS.editModal(game, articleId);
    const modal = await this.page(url);
    const form = this.form(modal.doc, SEL.editForm, "Edit article", url);
    const data = formData(form);
    data.delete("isFoil");
    for (const [k, v] of Object.entries(editFields({ ...fields, copies }))) data.set(k, v);
    return this.ajax(URLS.ajax(game, form.getAttribute("data-ajax-action")!), data, `edit article ${articleId}`);
  }

  /** Add (delta > 0) or remove (delta < 0) copies of an article: the offers page's +/- buttons. */
  async changeAmount(game: string, articleId: string, delta: number): Promise<{ message: string | null }> {
    if (!Number.isInteger(delta) || delta === 0) throw new Error(`Invalid quantity change ${delta}.`);
    let prefix = this.amountPrefix.get(game);
    if (!prefix) {
      const [category] = parseOffersCategories((await this.page(URLS.offers(game))).doc);
      if (category) this.rememberAmountPrefix(game, (await this.page(URLS.offersCategory(game, category))).text);
      prefix = this.amountPrefix.get(game);
    }
    if (!prefix) throw new Error("No quantity buttons found on Cardmarket's offers page.");
    const data = new FormData();
    data.set("args", amountArgs(prefix, articleId, delta));
    return this.ajax(URLS.ajax(game), data, `change the quantity of article ${articleId}`);
  }

  private amountPrefix = new Map<string, string>();

  private rememberAmountPrefix(game: string, html: string): void {
    const prefix = parseAmountArgsPrefix(html);
    if (prefix) this.amountPrefix.set(game, prefix);
  }

  private async ajax(url: string, body: FormData, what: string): Promise<{ message: string | null }> {
    const resp = await this.paced(url, { method: "POST", body });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Cardmarket answered ${resp.status} for ${url}`);
    const { ok, message } = parseAjaxResponse(text);
    if (!ok) throw new Error(`Cardmarket refused to ${what}: ${message ?? "no message"}`);
    return { message };
  }

  async listOrders(game: string, state: "Paid" | "Sent", maxPages = MAX_ORDER_PAGES): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const found = parseSalesList((await this.page(URLS.sales(game, state, page))).doc);
      const fresh = found.filter((id) => !ids.includes(id));
      if (!fresh.length) break;
      ids.push(...fresh);
    }
    return ids;
  }

  async readOrder(game: string, orderId: string, state: "paid" | "sent"): Promise<OrderRow> {
    return parseOrderPage((await this.page(URLS.order(game, orderId))).doc, orderId, state);
  }

  async markShipped(game: string, orderId: string, trackingCode: string): Promise<void> {
    const url = URLS.order(game, orderId);
    let current = await this.page(url);
    const code = trackingCode.trim();
    if (code) {
      const form = this.form(current.doc, SEL.ship.trackingForm, "Tracking number", url);
      const input = form.querySelector<HTMLInputElement>(SEL.ship.trackingInput);
      if (!input?.name) throw new Error(`No tracking number field on ${url}.`);
      const result = await this.post(form, current.url, { [input.name]: code });
      const { error } = parseAlerts(result.doc);
      if (error) throw new Error(`Cardmarket refused the tracking number: ${error}`);
      current = await this.page(url); // fresh form tokens
    }
    const result = await this.post(this.form(current.doc, SEL.ship.sendForm, "Mark as sent", url), current.url);
    const { error } = parseAlerts(result.doc);
    if (error) throw new Error(`Cardmarket refused to mark order ${orderId} as sent: ${error}`);
  }

  async handle(req: AgentRequest): Promise<AgentResponse> {
    try {
      switch (req.cmd) {
        case "whoami":
          return { ok: true, value: this.whoami() };
        case "readStock":
          return { ok: true, value: await this.readStock(req.game) };
        case "listArticle":
          return { ok: true, value: await this.listArticle(req.game, req.productId, req.quantity, req) };
        case "editArticle":
          return { ok: true, value: await this.editArticle(req.game, req.articleId, req.copies, req) };
        case "changeAmount":
          return { ok: true, value: await this.changeAmount(req.game, req.articleId, req.delta) };
        case "listOrders":
          return { ok: true, value: await this.listOrders(req.game, req.state, req.maxPages) };
        case "readOrder":
          return { ok: true, value: await this.readOrder(req.game, req.orderId, req.state) };
        case "markShipped":
          return { ok: true, value: await this.markShipped(req.game, req.orderId, req.trackingCode) };
      }
    } catch (exc) {
      return { ok: false, error: errorText(exc) };
    }
  }
}

declare global {
  interface Window {
    __cardledgerAgent?: Agent;
  }
}

// Installed once per page; the background then calls window.__cardledgerAgent.handle(request) through
// chrome.scripting.executeScript (same isolated world), which returns the awaited response.
if (typeof window !== "undefined" && location.hostname === "www.cardmarket.com" && !window.__cardledgerAgent) {
  window.__cardledgerAgent = new Agent({
    fetch: (...args) => fetch(...args),
    document,
    now: () => Date.now(),
    sleep,
  });
}
