// The CardLedger extension API contract (/api/extension/*), see cardledger_core's extension endpoints.
// Ledger codes: condition M|NM|EX|GD|LP|PL|PO, language EN|IT|DE|FR|ES|PT|JP|KO|ZHS|RU.

export type MarketCode = "cm" | "ct";
export const MARKETS: readonly MarketCode[] = ["cm", "ct"];
export const MARKET_NAMES: Record<MarketCode, string> = { cm: "Cardmarket", ct: "CardTrader" };

export interface User {
  username: string;
  full_name: string;
}

export interface ClaimResponse {
  token: string;
  user: User;
}

export interface MarketStatus {
  code: MarketCode;
  name: string;
  connected: boolean;
  status: "ok" | "error" | "never" | "off" | string;
  last_sync: string | null;
  handle: string;
}

export interface StatusResponse {
  user: User;
  markets: MarketStatus[];
  pending: Partial<Record<MarketCode, number>>;
}

export interface PlanItem {
  id: number;
  name: string;
  set_code: string;
  collector_number: string;
  cm_product_id: number | null;
  ct_blueprint_id: number | null;
  game: string;
  condition: string;
  language: string;
  foil: boolean;
  is_product: boolean;
}

export type PlanAction = "create" | "update" | "delete";

export interface PlanChange {
  listing_id: number;
  action: PlanAction;
  market_listing_id: string;
  item: PlanItem;
  quantity: number;
  price: string | number;
  comment: string;
}

export interface Plan {
  market: MarketCode;
  changes: PlanChange[];
}

export interface ChangeResult {
  listing_id: number;
  ok: boolean;
  market_listing_id?: string;
  error?: string;
}

export interface StockRow {
  market_listing_id: string;
  cm_product_id?: number | null;
  ct_blueprint_id?: number | null;
  name: string;
  set_code: string;
  collector_number: string;
  condition: string;
  language: string;
  foil: boolean;
  quantity: number;
  price: string;
}

export type OrderState = "paid" | "sent" | "arrived" | "canceled";

export interface OrderItemRow {
  market_item_id: string;
  market_listing_id?: string;
  name: string;
  expansion: string;
  condition: string;
  language: string;
  foil: boolean;
  quantity: number;
  price: string | null;
}

export interface OrderRow {
  market_order_id: string;
  state: OrderState;
  buyer_username: string;
  buyer_name: string;
  ship_name: string;
  ship_street: string;
  ship_zip: string;
  ship_city: string;
  ship_province: string;
  ship_country: string;
  ship_country_code: string;
  ship_note: string;
  shipping_method: string;
  tracked: boolean;
  tracking_code: string;
  paid_at: string | null;
  sent_at: string | null;
  items_total: string | null;
  shipping_cost: string | null;
  market_fee: string | null;
  total: string | null;
  net: string | null;
  currency: string;
  items: OrderItemRow[];
}

export interface Report {
  run_id: string;
  market: MarketCode;
  started_at: string;
  finished_at: string;
  results: ChangeResult[];
  stock?: StockRow[];
  orders?: OrderRow[];
  error?: string;
}

export interface ReportResponse {
  applied: number;
  conflicts: number;
  orders_new: number;
  unmatched: unknown[];
}

export interface ShippedRequest {
  market: MarketCode;
  market_order_id: string;
  tracking_code: string;
}

/** What one adapter run gathers; the orchestrator turns it into the Report. */
export interface MarketRunOutput {
  results: ChangeResult[];
  stock?: StockRow[];
  orders?: OrderRow[];
  /** Seller name on the market, when the adapter learns it (shown in the popup). */
  handle?: string;
}
