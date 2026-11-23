// Typed client of CardLedger's extension API (/api/extension/*).
// Authenticated calls send `Authorization: Token <token>` (the token obtained by pairing); only claim/ is anonymous.
// Errors follow cardledger_core's API format: {"detail", "code"} or DRF validation errors {"field": ["msg"]}.

import type {
  ClaimResponse,
  MarketCode,
  Plan,
  Report,
  ReportResponse,
  ShippedRequest,
  StatusResponse,
} from "../types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The token was revoked or is unknown: the extension must be paired again. */
  get unauthorized(): boolean {
    return this.status === 401 || this.code === "not_authenticated" || this.code === "authentication_failed";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string | null;
  fetch?: typeof fetch;
}

/** The CardLedger URL normalised to its origin + path without the trailing slash. */
export function normalizeBaseUrl(url: string): string {
  const u = new URL(url.trim());
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function errorMessage(data: unknown, status: number, statusText: string): { message: string; code: string; fields: Record<string, string[]> } {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.detail === "string") {
      return { message: d.detail, code: typeof d.code === "string" ? d.code : "error", fields: {} };
    }
    const fields: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v)) fields[k] = v.map(String);
    }
    const first = Object.entries(fields)[0];
    if (first) {
      const [name, msgs] = first;
      const prefix = name === "non_field_errors" ? "" : `${name}: `;
      return { message: `${prefix}${msgs.join(" ")}`, code: "invalid", fields };
    }
  }
  return { message: `CardLedger answered ${status}${statusText ? ` ${statusText}` : ""}`, code: "error", fields: {} };
}

export class CardLedgerClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token ?? null;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError("The extension is not paired with CardLedger.", 401, "not_paired");
      headers.Authorization = `Token ${this.token}`;
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/api/extension/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
      });
    } catch (exc) {
      throw new ApiError(`CardLedger unreachable at ${this.baseUrl}: ${(exc as Error).message}`, 0, "unreachable");
    }
    const text = await resp.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (resp.ok) throw new ApiError(`CardLedger ${method} ${path} answered with an unreadable response.`, resp.status, "parse_error");
      }
    }
    if (!resp.ok) {
      const { message, code, fields } = errorMessage(data, resp.status, resp.statusText);
      throw new ApiError(message, resp.status, code, fields);
    }
    return data as T;
  }

  /** Exchange a pairing code (shown on CardLedger's Account page) for a token. */
  claim(code: string, name: string): Promise<ClaimResponse> {
    return this.request("POST", "claim/", { code: code.trim().toUpperCase(), name }, false);
  }

  status(): Promise<StatusResponse> {
    return this.request("GET", "status/");
  }

  plan(market: MarketCode): Promise<Plan> {
    return this.request("GET", `plan/?market=${market}`);
  }

  report(report: Report): Promise<ReportResponse> {
    return this.request("POST", "report/", report);
  }

  shipped(body: ShippedRequest): Promise<unknown> {
    return this.request("POST", "shipped/", body);
  }
}
