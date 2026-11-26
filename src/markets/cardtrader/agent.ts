// The CardTrader agent: injected into a www.cardtrader.com tab (chrome.scripting.executeScript, isolated world), where
// its requests are same-origin and carry the seller's session cookies — no API token, no credentials seen or stored.
// It only does page work (fetch, parse with DOMParser, post forms, the site's own JSON calls): the background
// (adapter.ts) decides what to do. Every request waits MIN_REQUEST_GAP_MS after the previous one.
// Every URL, selector and format it relies on is in format.ts.

import { Pacer, formAction, formData } from "../../lib/forms";
import { errorText, sleep } from "../../lib/util";
import type { OrderRow, OrderState } from "../../types";
import {
  IMPORT_POLL_ATTEMPTS,
  IMPORT_POLL_GAP_MS,
  INDEX_SETTLE_MS,
  MAX_INVENTORY_PAGES,
  MAX_ORDER_PAGES,
  MIN_REQUEST_GAP_MS,
  SEL,
  URLS,
  editBody,
  isSignInPage,
  isSignInUrl,
  parseAlerts,
  parseCsrfToken,
  parseImportStatus,
  parseInventoryPage,
  parseOrderPage,
  parseOrdersList,
  parseUsername,
  type CtListState,
  type CtProductJson,
  type CtStockRow,
  toCtStockRow,
} from "./format";

export const NOT_LOGGED_IN = "Not logged in to CardTrader: log in on www.cardtrader.com in this browser and sync again.";

/** What a product is edited to (CardLedger codes). */
export interface CtEdit {
  quantity: number;
  price: string | number;
  condition: string;
  language: string;
  foil: boolean;
  comment: string;
  isProduct: boolean;
}

export type CtAgentRequest =
  | { cmd: "whoami" }
  | { cmd: "readInventory"; settle?: boolean }
  | { cmd: "readProducts"; productIds: string[] }
  | { cmd: "importProducts"; gameId: number; columns: string[]; csv: string }
  | ({ cmd: "updateProduct"; productId: string; blueprintId: number } & CtEdit)
  | { cmd: "deleteProduct"; productId: string; blueprintId: number }
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

  /** A same-origin JSON call as the site's own scripts make it (Rails CSRF token from the page); returns its JSON. */
  private async json<T = unknown>(method: string, url: string, csrf: string | null, body?: unknown): Promise<T | null> {
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
    const text = await resp.text().catch(() => "");
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      if (/<html/i.test(text) && isSignInPage(new DOMParser().parseFromString(text, "text/html"))) throw new Error(NOT_LOGGED_IN);
      throw new Error(`CardTrader ${method} ${url} did not answer JSON.`);
    }
  }

  /** The CSRF token of the tab's page (Rails keeps it valid for the whole session), else of a fresh page. */
  private async csrf(): Promise<string> {
    const token = parseCsrfToken(this.deps.document) ?? parseCsrfToken((await this.page(URLS.home())).doc);
    if (!token) throw new Error("No CSRF token on CardTrader's page.");
    return token;
  }

  private slug(): string {
    const slug = parseUsername(this.deps.document);
    if (!slug) throw new Error(NOT_LOGGED_IN);
    return slug;
  }

  private refusal(doc: Document, what: string): void {
    const { error, success } = parseAlerts(doc);
    if (error && !success) throw new Error(`CardTrader refused ${what}: ${error}`);
  }

  whoami(): { username: string | null } {
    return { username: parseUsername(this.deps.document) };
  }

  /** Every product of the seller ("My items" as JSON, page by page). The tag is not in these answers. */
  async readInventory(settle = false): Promise<CtStockRow[]> {
    const slug = this.slug();
    if (settle) await this.deps.sleep(INDEX_SETTLE_MS);
    const rows: CtStockRow[] = [];
    for (let page = 1; page <= MAX_INVENTORY_PAGES; page++) {
      const data = await this.json("GET", URLS.inventory(slug, page), null);
      const { rows: found, last } = parseInventoryPage(data);
      rows.push(...found.filter((r) => !rows.some((o) => o.market_listing_id === r.market_listing_id)));
      if (last) break;
    }
    return rows;
  }

  /** Some products as they are now, with their tag (null: deleted). One request each. */
  async readProducts(productIds: string[]): Promise<Record<string, CtStockRow | null>> {
    const out: Record<string, CtStockRow | null> = {};
    for (const id of productIds) {
      const resp = await this.pacer.fetch(URLS.productJson(id), { headers: { Accept: "application/json" } });
      if (isSignInUrl(resp.url || "")) throw new Error(NOT_LOGGED_IN);
      if (resp.status === 404) {
        out[id] = null;
        continue;
      }
      if (!resp.ok) throw new Error(`CardTrader answered ${resp.status} for ${URLS.productJson(id)}`);
      const data = (await resp.json()) as { product?: CtProductJson };
      if (!data.product) throw new Error(`CardTrader's answer for product ${id} has no product.`);
      out[id] = toCtStockRow(data.product);
    }
    return out;
  }

  /** "Sell via spreadsheet": upload the CSV, name its columns, start the import (adding), wait until it ends. */
  async importProducts(gameId: number, columns: string[], csv: string): Promise<{ message: string; errors: number }> {
    const start = await this.page(URLS.importNew());
    const upload = this.form(start.doc, SEL.importUploadForm, "Import upload", start.url);
    const file = upload.querySelector<HTMLInputElement>(SEL.importFile);
    if (!file?.name) throw new Error(`No file field in the import form on ${start.url}.`);
    const data = new FormData();
    for (const el of upload.querySelectorAll<HTMLInputElement>("input[type='hidden']")) if (el.name) data.append(el.name, el.value);
    data.append(file.name, new Blob([csv], { type: "text/csv" }), "cardledger.csv");
    const draft = await this.page(formAction(upload, start.url), { method: "POST", body: data });
    const map = this.form(draft.doc, SEL.importMapForm, "Import columns", draft.url);
    const importId = /\/product_imports\/(\d+)/.exec(map.getAttribute("action") ?? "")?.[1];
    if (!importId) throw new Error(`CardTrader did not accept the import file: ${parseAlerts(draft.doc).error ?? draft.url}`);
    const mapping = formData(map, { "product_import[game_id]": String(gameId), "product_import[replace_stock]": "false" });
    mapping.delete("product_import[csv_column_names][]");
    for (const c of columns) mapping.append("product_import[csv_column_names][]", c);
    if (mapping.get("product_import[replace_stock]") !== "false") throw new Error("Refusing an import that would replace the inventory.");
    let status = parseImportStatus((await this.page(formAction(map, draft.url), { method: "POST", body: mapping })).doc);
    for (let attempt = 0; !status.done && attempt < IMPORT_POLL_ATTEMPTS; attempt++) {
      await this.deps.sleep(IMPORT_POLL_GAP_MS);
      status = parseImportStatus((await this.page(URLS.importStatus(importId))).doc);
    }
    if (!status.done) throw new Error(`CardTrader's import ${importId} did not end in time.`);
    return { message: status.message, errors: status.errors };
  }

  /** Edit a product as the "My items" edit panel does (its current properties first, for their names). */
  async updateProduct(productId: string, blueprintId: number, edit: CtEdit): Promise<void> {
    const current = await this.json<{ product?: CtProductJson }>("GET", URLS.productJson(productId), null);
    if (!current?.product) throw new Error(`Product ${productId} not found on CardTrader.`);
    const token = await this.csrf();
    await this.json("PATCH", URLS.productEdit(current.product.blueprint_id || blueprintId, productId), token, editBody(current.product, edit, token));
  }

  async deleteProduct(productId: string, blueprintId: number): Promise<void> {
    await this.json("DELETE", URLS.productEdit(blueprintId, productId), await this.csrf(), null);
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
        case "readInventory":
          return { ok: true, value: await this.readInventory(req.settle) };
        case "readProducts":
          return { ok: true, value: await this.readProducts(req.productIds) };
        case "importProducts":
          return { ok: true, value: await this.importProducts(req.gameId, req.columns, req.csv) };
        case "updateProduct":
          return { ok: true, value: await this.updateProduct(req.productId, req.blueprintId, req) };
        case "deleteProduct":
          return { ok: true, value: await this.deleteProduct(req.productId, req.blueprintId) };
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
