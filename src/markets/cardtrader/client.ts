// HTTP client for the CardTrader Full API v2 (https://www.cardtrader.com/docs/api/full/reference), a port of
// cardledger_core's ledger/cardtrader.py: the same endpoints, payloads and limits.

import { sleep as realSleep } from "../../lib/util";

export const BASE_URL = "https://api.cardtrader.com/api/v2";

export class CardTraderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "CardTraderError";
  }
}

export interface CtGame {
  id: number;
  name?: string;
  display_name?: string;
}
export interface CtExpansion {
  id: number;
  game_id?: number;
  code?: string;
  name?: string;
}
export interface CtBlueprint {
  id: number;
  name: string;
  version?: string | null;
  card_market_ids?: number[] | null;
  fixed_properties?: Record<string, unknown> | null;
  editable_properties?: Array<{ name?: string }> | null;
}
export interface CtProduct {
  id: number;
  blueprint_id?: number;
  name_en?: string;
  quantity?: number;
  price_cents?: number;
  price?: { cents?: number; currency?: string };
  properties_hash?: Record<string, unknown>;
  expansion?: { id?: number; code?: string; name_en?: string };
  user_data_field?: string | null;
  description?: string | null;
}
export interface CtJobResult {
  job_index?: number;
  result?: string;
  product_id?: number;
  errors?: unknown;
}
export interface CtMoney {
  cents?: number | null;
  currency?: string;
}
export interface CtOrder {
  id: number;
  code?: string;
  state?: string;
  via_cardtrader_zero?: boolean;
  buyer?: { username?: string; email?: string; phone?: string } | null;
  paid_at?: string | null;
  sent_at?: string | null;
  seller_total?: CtMoney | null;
  seller_subtotal?: CtMoney | null;
  seller_fee_amount?: CtMoney | null;
  order_shipping_address?: Record<string, string | null> | null;
  order_shipping_method?: {
    name?: string;
    tracked?: boolean;
    tracking_code?: string | null;
    seller_price?: CtMoney | null;
  } | null;
  order_items?: Array<{
    id: number;
    product_id?: number | null;
    name?: string;
    expansion?: string;
    quantity?: number;
    seller_price?: CtMoney | null;
    properties?: Record<string, unknown>;
  }>;
}

export interface CardTraderOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class CardTraderClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly token: string,
    options: CardTraderOptions = {},
  ) {
    if (!token) throw new CardTraderError("CardTrader API token is not configured.");
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? realSleep;
  }

  private async request<T>(method: string, path: string, params?: Record<string, unknown>, body?: unknown): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Redirects are not followed: CardTrader sends them (HTML, to its root) when the API is unavailable.
        redirect: "manual",
        credentials: "omit",
      });
    } catch (exc) {
      throw new CardTraderError(`CardTrader unreachable: ${(exc as Error).message}`);
    }
    if (resp.status === 429) throw new CardTraderError("CardTrader rate limit exceeded, retry in a few seconds.", 429);
    const text = resp.type === "opaqueredirect" ? "" : await resp.text();
    let data: unknown = null;
    let parsed = true;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        parsed = false;
      }
    }
    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      let message: string | undefined;
      if (data && typeof data === "object") {
        const d = data as { extra?: { message?: string }; error?: string; error_code?: string };
        message = d.extra?.message || d.error || d.error_code;
      }
      const status = resp.type === "opaqueredirect" ? "redirect: API unavailable" : String(resp.status);
      throw new CardTraderError(
        `CardTrader ${method} ${path} failed (${status}): ${message || resp.statusText || "error"}`,
        resp.status,
        data,
      );
    }
    if (!parsed) throw new CardTraderError(`CardTrader ${method} ${path} answered with an unreadable response.`, resp.status);
    return data as T;
  }

  // --- catalog -------------------------------------------------------------

  /** CardTrader's games (also accepted wrapped as {"array": [...]}). */
  async games(): Promise<CtGame[]> {
    const data = await this.request<CtGame[] | { array?: CtGame[] }>("GET", "/games");
    return (Array.isArray(data) ? data : data?.array) ?? [];
  }

  async expansions(): Promise<CtExpansion[]> {
    return (await this.request<CtExpansion[]>("GET", "/expansions")) ?? [];
  }

  async blueprints(expansionId: number): Promise<CtBlueprint[]> {
    return (await this.request<CtBlueprint[]>("GET", "/blueprints/export", { expansion_id: expansionId })) ?? [];
  }

  // --- inventory -------------------------------------------------------------

  async myProducts(): Promise<CtProduct[]> {
    return (await this.request<CtProduct[]>("GET", "/products/export")) ?? [];
  }

  bulkCreate(products: object[]): Promise<CtJobResult[]> {
    return this.runJob("/products/bulk_create", products);
  }

  bulkUpdate(products: object[]): Promise<CtJobResult[]> {
    return this.runJob("/products/bulk_update", products);
  }

  deleteProduct(productId: number | string): Promise<unknown> {
    return this.request("DELETE", `/products/${productId}`);
  }

  job(uuid: string): Promise<{ state?: string; results?: CtJobResult[] }> {
    return this.request("GET", `/jobs/${uuid}`);
  }

  /** Start a bulk job and wait for it (1 poll per second, /jobs is limited to that). Results sorted by job_index. */
  private async runJob(path: string, products: object[], maxWait = 60): Promise<CtJobResult[]> {
    if (!products.length) return [];
    const { job: uuid } = await this.request<{ job: string }>("POST", path, undefined, { products });
    let waited = 0;
    for (;;) {
      await this.sleep(1000);
      waited += 1;
      const job = await this.job(uuid);
      if (job.state === "completed") {
        return [...(job.results ?? [])].sort((a, b) => (a.job_index ?? 0) - (b.job_index ?? 0));
      }
      if (job.state === "unprocessable") throw new CardTraderError(`CardTrader job ${uuid} failed`, undefined, job);
      if (waited >= maxWait) throw new CardTraderError(`CardTrader job ${uuid} still ${job.state} after ${maxWait}s`, undefined, job);
    }
  }

  // --- orders ----------------------------------------------------------------

  orders(page = 1, dateFrom?: string | null, limit = 100): Promise<CtOrder[]> {
    return this.request("GET", "/orders", {
      page,
      limit,
      order_as: "seller",
      sort: "date.desc",
      from: dateFrom ?? undefined,
    });
  }

  /** Every seller order since dateFrom (YYYY-MM-DD), page by page (100 each, at most maxPages). */
  async allOrders(dateFrom?: string | null, maxPages = 20): Promise<CtOrder[]> {
    const all: CtOrder[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = (await this.orders(page, dateFrom)) ?? [];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  setTrackingCode(orderId: number | string, trackingCode: string): Promise<unknown> {
    return this.request("PUT", `/orders/${orderId}/tracking_code`, undefined, { tracking_code: trackingCode });
  }

  ship(orderId: number | string): Promise<CtOrder | unknown> {
    return this.request("PUT", `/orders/${orderId}/ship`);
  }
}
