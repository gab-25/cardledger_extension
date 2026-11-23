// Finding the user's www.cardtrader.com tab and talking to the agent injected into it.

import { connectAgent as connect, findTab } from "../tab";
import type { CtAgentCall } from "./adapter";
import type { CtAgentRequest } from "./agent";

export const NO_TAB = "Open www.cardtrader.com in a tab (logged in as the seller), then sync again.";

export function findCardTraderTab(): Promise<chrome.tabs.Tab | null> {
  return findTab("https://www.cardtrader.com/*");
}

export function connectAgent(tabId: number): Promise<CtAgentCall> {
  return connect<CtAgentRequest>(tabId, "cardtrader-agent.js", "__cardledgerCtAgent", "CardTrader");
}
