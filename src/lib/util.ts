export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Canonical collector number, as cardledger_core's catalog.normalize_number: "012a" -> "12A". */
export function normalizeNumber(value: string | null | undefined): string {
  const v = (value ?? "").trim().replace(/ /g, "").toUpperCase();
  const m = /^0*(\d+)(.*)$/.exec(v);
  return m ? (m[1] || "0") + m[2] : v;
}

/** A decimal amount as CardLedger's API writes it: "12.30". null for nothing. */
export function decimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return value.toFixed(2);
}

/** Cents (or CardTrader's Money {cents, currency}) -> "12.34". */
export function fromCents(value: number | { cents?: number | null } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cents = typeof value === "number" ? value : value.cents;
  if (cents === null || cents === undefined) return null;
  return (Math.round(cents) / 100).toFixed(2);
}

export function errorText(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}
