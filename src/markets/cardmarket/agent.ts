// The Cardmarket agent: injected into a cardmarket.com tab (chrome.scripting.executeScript, isolated world), where its
// requests are same-origin and carry the seller's session cookies — the extension never sees or stores credentials.
// It only does page work (fetch, parse with DOMParser, post forms): the background (adapter.ts) decides what to do.
// Every request waits MIN_REQUEST_GAP_MS after the previous one, so the site is never hammered.

import { errorText, sleep } from "../../lib/util";
import type { OrderRow, StockRow } from "../../types";
import {
  EXPORT_POLL_ATTEMPTS,
  EXPORT_POLL_GAP_MS,
  MAX_ORDER_PAGES,
  MIN_REQUEST_GAP_MS,
  SEL,
  URLS,
  formAction,
  formData,
  looksLikeCsv,
  parseAlerts,
  parseExportLink,
  parseOrderPage,
  parseSalesList,
  parseStockCsv,
  parseUsername,
} from "./format";

export type AgentRequest =
  | { cmd: "whoami" }
  | { cmd: "exportStock"; game: string }
  | { cmd: "importStock"; game: string; csv: string }
  | { cmd: "removeArticle"; game: string; articleId: string }
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

  async exportStock(game: string): Promise<StockRow[]> {
    const url = URLS.stockExport(game);
    const start = await this.page(url);
    const posted = await this.post(this.form(start.doc, SEL.exportForm, "Stock export", url), start.url);
    if (looksLikeCsv(posted.text, posted.type)) return parseStockCsv(posted.text);
    let link = parseExportLink(posted.doc);
    for (let attempt = 0; !link && attempt < EXPORT_POLL_ATTEMPTS; attempt++) {
      await this.deps.sleep(EXPORT_POLL_GAP_MS);
      link = parseExportLink((await this.page(url)).doc);
    }
    if (!link) throw new Error(`The stock export file did not appear on ${url}.`);
    const file = await this.paced(link);
    const text = await file.text();
    if (!file.ok || !looksLikeCsv(text, file.headers.get("content-type") ?? "")) {
      throw new Error(`The stock export at ${link} is not a CSV file.`);
    }
    return parseStockCsv(text);
  }

  async importStock(game: string, csv: string): Promise<{ message: string | null }> {
    const url = URLS.stockImport(game);
    const start = await this.page(url);
    const form = this.form(start.doc, SEL.importForm, "Stock import", url);
    const fileInput = form.querySelector<HTMLInputElement>(SEL.importFile);
    if (!fileInput?.name) throw new Error(`No file field in the stock import form on ${url}.`);
    const result = await this.post(form, start.url, { [fileInput.name]: new Blob([csv], { type: "text/csv" }) });
    const alerts = parseAlerts(result.doc);
    if (alerts.error && !alerts.success) throw new Error(`Cardmarket refused the import: ${alerts.error}`);
    return { message: alerts.success ?? alerts.error };
  }

  async removeArticle(game: string, articleId: string): Promise<void> {
    const url = URLS.article(game, articleId);
    const start = await this.page(url);
    const result = await this.post(this.form(start.doc, SEL.articleRemoveForm, "Remove article", url), start.url);
    const { error } = parseAlerts(result.doc);
    if (error) throw new Error(`Cardmarket refused to remove article ${articleId}: ${error}`);
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
        case "exportStock":
          return { ok: true, value: await this.exportStock(req.game) };
        case "importStock":
          return { ok: true, value: await this.importStock(req.game, req.csv) };
        case "removeArticle":
          return { ok: true, value: await this.removeArticle(req.game, req.articleId) };
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
