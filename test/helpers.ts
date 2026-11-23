/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanChange, PlanItem } from "../src/types";

export function fixture(name: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
}

export function html(text: string): Document {
  return new DOMParser().parseFromString(text, "text/html");
}

let nextId = 1;

export function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: nextId++,
    name: "Ragavan, Nimble Pilferer",
    set_code: "MH2",
    collector_number: "138",
    cm_product_id: 576041,
    ct_blueprint_id: null,
    game: "mtg",
    condition: "NM",
    language: "EN",
    foil: false,
    is_product: false,
    ...overrides,
  };
}

export function change(overrides: Partial<Omit<PlanChange, "item">> & { item?: Partial<PlanItem> } = {}): PlanChange {
  const { item: itemOverrides, ...rest } = overrides;
  return {
    listing_id: nextId++,
    action: "create",
    market_listing_id: "",
    quantity: 1,
    price: "10.00",
    comment: "",
    ...rest,
    item: item(itemOverrides),
  };
}

/** A fetch mock answering JSON by "METHOD path" (path without origin, with the query), recording every call. */
export function jsonFetch(routes: Record<string, (body: unknown, url: URL) => [number, unknown] | unknown>) {
  const calls: Array<{ method: string; url: URL; body: unknown; headers: Record<string, string> }> = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const key = `${method} ${url.pathname}${url.search}`;
    const route = routes[key] ?? routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ detail: "Not found.", code: "not_found" }), { status: 404 });
    const out = route(body, url);
    const [status, data] = Array.isArray(out) && typeof out[0] === "number" && out.length === 2 ? (out as [number, unknown]) : [200, out];
    return new Response(data === undefined ? "" : JSON.stringify(data), { status: status as number });
  };
  return { fetch: impl as typeof fetch, calls };
}
