// Which market a tab is on: a market is synced from the popup only while its own site is the active tab.

import type { MarketCode } from "../types";

/** The site of each market (https only, as the agents' host permissions). */
export const MARKET_ORIGINS: Record<MarketCode, string> = {
  cm: "https://www.cardmarket.com",
  ct: "https://www.cardtrader.com",
};

/** The market whose site a URL is on, or null (other sites, hidden or invalid URLs). */
export function marketOfUrl(url: string | null | undefined): MarketCode | null {
  let origin: string;
  try {
    origin = new URL(url ?? "").origin;
  } catch {
    return null;
  }
  const found = (Object.keys(MARKET_ORIGINS) as MarketCode[]).find((code) => MARKET_ORIGINS[code] === origin);
  return found ?? null;
}
