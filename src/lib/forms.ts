// Posting a site's own HTML forms from an agent: the fields as the browser would send them (hidden anti-CSRF tokens
// included), with overrides. Used by the Cardmarket and CardTrader agents.

/** The fields of a form as the site would post them, with overrides (a Blob override is sent as a file). */
export function formData(form: HTMLFormElement, overrides: Record<string, string | Blob> = {}, fileName = "stock.csv"): FormData {
  const data = new FormData();
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
    if (!el.name || el.disabled) continue;
    if (el instanceof HTMLInputElement) {
      if (el.type === "file" || el.type === "submit" || el.type === "button") continue;
      if ((el.type === "checkbox" || el.type === "radio") && !el.checked) continue;
    }
    data.append(el.name, el.value);
  }
  for (const [k, v] of Object.entries(overrides)) {
    data.delete(k);
    if (typeof v === "string") data.append(k, v);
    else data.append(k, v, fileName);
  }
  return data;
}

/** Absolute URL a form posts to (its page when it has no action). */
export function formAction(form: HTMLFormElement, pageUrl: string): string {
  return new URL(form.getAttribute("action") || pageUrl, pageUrl).toString();
}

/** fetch with at least gapMs between the end of a request and the start of the next one (one site, one pacer). */
export class Pacer {
  private last = 0;

  constructor(
    private readonly deps: { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> },
    private readonly gapMs: number,
  ) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const wait = this.last + this.gapMs - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait);
    try {
      return await this.deps.fetch(url, { credentials: "same-origin", redirect: "follow", ...init });
    } finally {
      this.last = this.deps.now();
    }
  }
}
