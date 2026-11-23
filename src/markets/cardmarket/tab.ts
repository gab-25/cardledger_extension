// Finding the user's cardmarket.com tab and talking to the agent injected into it.

import type { AgentRequest, AgentResponse } from "./agent";
import type { AgentCall } from "./adapter";

export const NO_TAB = "Open cardmarket.com in a tab (logged in as the seller), then sync again.";

/** The most recently used cardmarket.com tab, or null. */
export async function findCardmarketTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: "https://www.cardmarket.com/*" });
  const usable = tabs.filter((t) => t.id !== undefined && t.status !== "unloaded" && !t.discarded);
  usable.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return usable[0] ?? null;
}

/** Inject the agent (once per page) into the tab and return a function calling it. */
export async function connectAgent(tabId: number): Promise<AgentCall> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["cardmarket-agent.js"] });
  return async <T>(req: AgentRequest): Promise<T> => {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (r: AgentRequest) => {
        const agent = window.__cardledgerAgent;
        if (!agent) return { ok: false, error: "The CardLedger agent is not loaded in the Cardmarket tab." };
        return agent.handle(r);
      },
      args: [req],
    });
    const resp = frame?.result as AgentResponse<T> | undefined;
    if (!resp) throw new Error("The Cardmarket tab did not answer (was it closed or reloaded?).");
    if (!resp.ok) throw new Error(resp.error);
    return resp.value;
  };
}
