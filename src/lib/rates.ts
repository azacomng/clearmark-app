// Server-side EUR/USD reference rate for quoting EUR invoices in USDC.
// CLEARMARK_EUR_PER_USD pins a rate (e.g. "0.92") for testing; otherwise the ECB reference rate
// is read from frankfurter.app and cached for an hour. Null means no rate: USDC payment of EUR
// invoices is switched off until one is available (EURC still works 1:1).

import "server-only";
import { toUnits } from "./money";

let cache: { rate: bigint; source: string; at: number } | null = null;
const TTL = 60 * 60_000;

export async function eurPerUsdc(): Promise<{ rate: bigint; source: string } | null> {
  const pinned = process.env.CLEARMARK_EUR_PER_USD;
  if (pinned) {
    try {
      return { rate: toUnits(pinned), source: "Fixed test rate" };
    } catch {
      /* fall through to the live rate */
    }
  }
  if (cache && Date.now() - cache.at < TTL) return cache;
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR", { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { rates?: { EUR?: number }; date?: string };
    const eur = data.rates?.EUR;
    if (!eur || eur <= 0 || eur > 5) throw new Error("bad rate");
    // USDC is treated as 1 USD; the reference rate is rounded to 6 decimals.
    cache = { rate: toUnits(eur.toFixed(6)), source: `ECB reference rate${data.date ? ` (${data.date})` : ""}`, at: Date.now() };
    return cache;
  } catch {
    return cache; // a stale rate beats none; null if we never had one
  }
}
