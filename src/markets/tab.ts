// Finding the user's tab on a market site and talking to the agent injected into it (shared by Cardmarket and
// CardTrader). An agent is a content script built as IIFE that installs itself as window[global] and answers
// handle(request) with {ok, value} | {ok: false, error}.

/** Sends one request to an agent and returns its value (throws its error). */
export type AgentCall<R = unknown> = <T>(req: R) => Promise<T>;

type AgentResponse = { ok: true; value: unknown } | { ok: false; error: string };

/** The most recently used tab whose URL matches the pattern, or null. */
export async function findTab(urlPattern: string): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  const usable = tabs.filter((t) => t.id !== undefined && t.status !== "unloaded" && !t.discarded);
  usable.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return usable[0] ?? null;
}

/** Inject the agent script (it installs itself once per page) into the tab and return a function calling it. */
export async function connectAgent<R>(tabId: number, file: string, global: string, site: string): Promise<AgentCall<R>> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  return async <T>(req: R): Promise<T> => {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (name: string, siteName: string, r: unknown) => {
        const agent = (window as unknown as Record<string, { handle(r: unknown): Promise<unknown> } | undefined>)[name];
        if (!agent) return { ok: false, error: `The CardLedger agent is not loaded in the ${siteName} tab.` };
        return agent.handle(r);
      },
      args: [global, site, req as unknown],
    });
    const resp = frame?.result as AgentResponse | undefined;
    if (!resp) throw new Error(`The ${site} tab did not answer (was it closed or reloaded?).`);
    if (!resp.ok) throw new Error(resp.error);
    return resp.value as T;
  };
}
