// Finding the user's cardmarket.com tab and talking to the agent injected into it.

import { connectAgent as connect, findTab } from "../tab";
import type { AgentRequest } from "./agent";
import type { AgentCall } from "./adapter";

export const NO_TAB = "Open cardmarket.com in a tab (logged in as the seller), then sync again.";

/** The most recently used cardmarket.com tab, or null. */
export function findCardmarketTab(): Promise<chrome.tabs.Tab | null> {
  return findTab("https://www.cardmarket.com/*");
}

/** Inject the agent (once per page) into the tab and return a function calling it. */
export function connectAgent(tabId: number): Promise<AgentCall> {
  return connect<AgentRequest>(tabId, "cardmarket-agent.js", "__cardledgerAgent", "Cardmarket");
}
