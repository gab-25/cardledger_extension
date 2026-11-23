// The CardTrader agent: injected into a www.cardtrader.com tab (chrome.scripting.executeScript, isolated world), where
// its requests are same-origin and carry the seller's session cookies — no API token, no credentials seen or stored.
// It only does page work (fetch, parse with DOMParser, post forms, the site's own JSON calls): the background
// (adapter.ts) decides what to do. Every request waits MIN_REQUEST_GAP_MS after the previous one.
// Every URL, selector and format it relies on is in format.ts.

import { Pacer, formAction, formData } from "../../lib/forms";
import { errorText, sleep } from "../../lib/util";
import type { OrderRow, OrderState } from "../../types";
import {
  EXPORT_POLL_ATTEMPTS,
  EXPORT_POLL_GAP_MS,
  IMPORT_OVERRIDES,
  IMPORT_SETTLE_MS,
  MAX_ORDER_PAGES,
  MIN_REQUEST_GAP_MS,
  SEL,
  URLS,
  isSignInPage,
  isSignInUrl,
  looksLikeCsv,
  parseAlerts,
  parseCsrfToken,
  parseExportLink,
  parseInventoryCsv,
  parseOrderPage,
  parseOrdersList,
  parseUsername,
  type CtListState,
  type CtStockRow,
} from "./format";

export const NOT_LOGGED_IN = "Not logged in to CardTrader: log in on www.cardtrader.com in this browser and sync again.";

export type CtAgentRequest =
  | { cmd: "whoami" }
  | { cmd: "exportInventory" }
  | { cmd: "importInventory"; csv: string }
  | { cmd: "removeProduct"; productId: string }
  | { cmd: "listOrders"; state: CtListState; maxPages?: number }
  | { cmd: "readOrder"; orderId: string; state: OrderState }
  | { cmd: "markShipped"; orderId: string; trackingCode: string };

export type CtAgentResponse<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export interface CtAgentDeps {
  fetch: typeof fetch;
  document: Document;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface Page {
  doc: Document;
  url: string;
  text: string;
  type: string;
}

export class CardTraderAgent {
  private readonly pacer: Pacer;

  constructor(private readonly deps: CtAgentDeps) {
    this.pacer = new Pacer(deps, MIN_REQUEST_GAP_MS);
  }

  private async page(url: string, init?: RequestInit): Promise<Page> {
    const resp = await this.pacer.fetch(url, init);
    const text = await resp.text();
    if (isSignInUrl(resp.url || "")) throw new Error(NOT_LOGGED_IN);
    if (!resp.ok) throw new Error(`CardTrader answered ${resp.status} for ${url}`);
    const doc = new DOMParser().parseFromString(text, "text/html");
    if (isSignInPage(doc)) throw new Error(NOT_LOGGED_IN);
    return { doc, url: resp.url || url, text, type: resp.headers.get("content-type") ?? "" };
  }

  private form(doc: Document, selector: string, what: string, url: string): HTMLFormElement {
    const form = doc.querySelector<HTMLFormElement>(selector);
    if (!form) throw new Error(`${what} form not found on ${url} (selector in cardtrader/format.ts: ${selector}).`);
    return form;
  }

  private post(form: HTMLFormElement, pageUrl: string, overrides: Record<string, string | Blob> = {}, fileName?: string) {
    return this.page(formAction(form, pageUrl), { method: "POST", body: formData(form, overrides, fileName) });
  }

  /** A same-origin JSON call as the site's own scripts make it (Rails CSRF token from the page). */
  private async json(method: string, url: string, csrf: string | null, body?: unknown): Promise<void> {
    const resp = await this.pacer.fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (isSignInUrl(resp.url || "")) throw new Error(NOT_LOGGED_IN);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      let message = "";
      try {
        const data = JSON.parse(text) as { error?: string; message?: string; extra?: { message?: string } };
        message = data.extra?.message || data.error || data.message || "";
      } catch {
        // not JSON
      }
      throw new Error(`CardTrader ${method} ${url} failed (${resp.status})${message ? `: ${message}` : ""}`);
    }
  }

  private refusal(doc: Document, what: string): void {
    const { error, success } = parseAlerts(doc);
    if (error && !success) throw new Error(`CardTrader refused ${what}: ${error}`);
  }

  whoami(): { username: string | null } {
    return { username: parseUsername(this.deps.document) };
  }

  async exportInventory(): Promise<CtStockRow[]> {
    const url = URLS.inventoryExport();
    const start = await this.page(url);
    if (looksLikeCsv(start.text, start.type)) return parseInventoryCsv(start.text);
    let link = parseExportLink(start.doc);
    if (!link) {
      const posted = await this.post(this.form(start.doc, SEL.exportForm, "Inventory export", url), start.url);
      if (looksLikeCsv(posted.text, posted.type)) return parseInventoryCsv(posted.text);
      link = parseExportLink(posted.doc);
    }
    for (let attempt = 0; !link && attempt < EXPORT_POLL_ATTEMPTS; attempt++) {
      await this.deps.sleep(EXPORT_POLL_GAP_MS);
      link = parseExportLink((await this.page(url)).doc);
    }
    if (!link) throw new Error(`The inventory export file did not appear on ${url}.`);
    const file = await this.pacer.fetch(link);
    const text = await file.text();
    if (!file.ok || !looksLikeCsv(text, file.headers.get("content-type") ?? "")) {
      throw new Error(`The inventory export at ${link} is not a CSV file.`);
    }
    return parseInventoryCsv(text);
  }

  async importInventory(csv: string): Promise<{ message: string | null }> {
    const url = URLS.inventoryImport();
    const start = await this.page(url);
    const form = this.form(start.doc, SEL.importForm, "Inventory import", url);
    const fileInput = form.querySelector<HTMLInputElement>(SEL.importFile);
    if (!fileInput?.name) throw new Error(`No file field in the inventory import form on ${url}.`);
    const result = await this.post(
      form,
      start.url,
      { ...IMPORT_OVERRIDES, [fileInput.name]: new Blob([csv], { type: "text/csv" }) },
      "cardledger-inventory.csv",
    );
    this.refusal(result.doc, "the import");
    await this.deps.sleep(IMPORT_SETTLE_MS);
    const alerts = parseAlerts(result.doc);
    return { message: alerts.success ?? alerts.error };
  }

  async removeProduct(productId: string): Promise<void> {
    const url = URLS.product(productId);
    const start = await this.page(url);
    const result = await this.post(this.form(start.doc, SEL.productRemoveForm, "Delete product", url), start.url);
    this.refusal(result.doc, `to delete product ${productId}`);
  }

  async listOrders(state: CtListState, maxPages = MAX_ORDER_PAGES): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const fresh = parseOrdersList((await this.page(URLS.orders(state, page))).doc).filter((id) => !ids.includes(id));
      if (!fresh.length) break;
      ids.push(...fresh);
    }
    return ids;
  }

  async readOrder(orderId: string, state: OrderState): Promise<OrderRow> {
    return parseOrderPage((await this.page(URLS.order(orderId))).doc, orderId, state);
  }

  /** Save the tracking code (if any), then mark shipped: with the page's forms, else its JSON calls. */
  async markShipped(orderId: string, trackingCode: string): Promise<void> {
    const url = URLS.order(orderId);
    let current = await this.page(url);
    const code = trackingCode.trim();
    if (code) {
      const form = current.doc.querySelector<HTMLFormElement>(SEL.ship.trackingForm);
      if (form) {
        const input = form.querySelector<HTMLInputElement>(SEL.ship.trackingInput);
        if (!input?.name) throw new Error(`No tracking code field on ${url}.`);
        this.refusal((await this.post(form, current.url, { [input.name]: code })).doc, "the tracking code");
        current = await this.page(url); // fresh tokens and the ship form
      } else {
        await this.json("PUT", URLS.orderTrackingJson(orderId), parseCsrfToken(current.doc), { tracking_code: code });
      }
    }
    const ship = current.doc.querySelector<HTMLFormElement>(SEL.ship.shipForm);
    if (ship) this.refusal((await this.post(ship, current.url)).doc, `to mark order ${orderId} shipped`);
    else await this.json("PUT", URLS.orderShipJson(orderId), parseCsrfToken(current.doc));
  }

  async handle(req: CtAgentRequest): Promise<CtAgentResponse> {
    try {
      switch (req.cmd) {
        case "whoami":
          return { ok: true, value: this.whoami() };
        case "exportInventory":
          return { ok: true, value: await this.exportInventory() };
        case "importInventory":
          return { ok: true, value: await this.importInventory(req.csv) };
        case "removeProduct":
          return { ok: true, value: await this.removeProduct(req.productId) };
        case "listOrders":
          return { ok: true, value: await this.listOrders(req.state, req.maxPages) };
        case "readOrder":
          return { ok: true, value: await this.readOrder(req.orderId, req.state) };
        case "markShipped":
          return { ok: true, value: await this.markShipped(req.orderId, req.trackingCode) };
      }
    } catch (exc) {
      return { ok: false, error: errorText(exc) };
    }
  }
}

declare global {
  interface Window {
    __cardledgerCtAgent?: CardTraderAgent;
  }
}

// Installed once per page; the background then calls window.__cardledgerCtAgent.handle(request) through
// chrome.scripting.executeScript (same isolated world), which returns the awaited response.
if (typeof window !== "undefined" && location.hostname === "www.cardtrader.com" && !window.__cardledgerCtAgent) {
  window.__cardledgerCtAgent = new CardTraderAgent({
    fetch: (...args) => fetch(...args),
    document,
    now: () => Date.now(),
    sleep,
  });
}
