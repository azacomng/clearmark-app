// Smart Terms: an optional early-pay discount and an optional late fee on an invoice.
// The price that applies is decided by the settle timestamp of the payment that covers the
// invoice. Arc finality is deterministic, so that timestamp is never in dispute.
//
//   amount 250, 2% off within 3 days, 1.5% late fee
//   paid on day 2            -> 245.00 settles it
//   paid before the due date -> 250.00
//   paid after the due date  -> 253.75

import { fmt } from "./money";
import type { Invoice, Terms } from "./types";

const DAY = 86_400_000;
export const BPS = 10_000n;

/** Last moment the early-pay price applies, or null when the invoice has no discount. */
export function earlyDeadline(inv: Pick<Invoice, "createdAt" | "terms">): string | null {
  const t = inv.terms;
  if (!t || !t.earlyBps || !t.earlyDays) return null;
  return new Date(Date.parse(inv.createdAt) + t.earlyDays * DAY).toISOString();
}

export type PriceKind = "early" | "standard" | "late";

/** The invoice price at a moment in time, in invoice units. */
export function priceAt(inv: Pick<Invoice, "amount" | "createdAt" | "dueDate" | "terms">, at: string | Date): { amount: bigint; kind: PriceKind } {
  const A = BigInt(inv.amount);
  const t = inv.terms;
  if (!t) return { amount: A, kind: "standard" };
  const iso = typeof at === "string" ? at : at.toISOString();
  const early = earlyDeadline(inv);
  if (early && iso <= early) return { amount: A - (A * BigInt(t.earlyBps)) / BPS, kind: "early" };
  if (t.lateBps && iso.slice(0, 10) > inv.dueDate) return { amount: A + (A * BigInt(t.lateBps)) / BPS, kind: "late" };
  return { amount: A, kind: "standard" };
}

export const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** One plain line stating the terms, shown on the invoice and at checkout. */
export function termsLine(inv: Pick<Invoice, "amount" | "createdAt" | "dueDate" | "terms">, unit = "USDC"): string | null {
  const t = inv.terms;
  if (!t) return null;
  const parts: string[] = [];
  if (t.earlyBps && t.earlyDays) {
    parts.push(`${pct(t.earlyBps)} off if paid within ${t.earlyDays} day${t.earlyDays === 1 ? "" : "s"} (${fmt(priceAt(inv, inv.createdAt).amount)} ${unit})`);
  }
  if (t.lateBps) parts.push(`${pct(t.lateBps)} late fee after the due date`);
  return parts.length ? parts.join(" · ") : null;
}

export interface TermsInput {
  earlyPct?: string | number | null;
  earlyDays?: string | number | null;
  latePct?: string | number | null;
}

const toBps = (v: string | number | null | undefined, max: number, what: string): number => {
  if (v === null || v === undefined || String(v).trim() === "") return 0;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a percentage.`);
  const bps = Math.round(n * 100);
  if (bps > max) throw new Error(`${what} can be at most ${max / 100}%.`);
  return bps;
};

/** Validate the form input. Returns null when no term is switched on. */
export function parseTerms(input: TermsInput | null | undefined, createdAt: string, dueDate: string): Terms | null {
  if (!input) return null;
  const earlyBps = toBps(input.earlyPct, 2000, "The early-pay discount");
  const lateBps = toBps(input.latePct, 2500, "The late fee");
  let earlyDays = 0;
  if (earlyBps) {
    earlyDays = Number(input.earlyDays);
    if (!Number.isInteger(earlyDays) || earlyDays < 1 || earlyDays > 60) throw new Error("The discount window must be 1 to 60 days.");
    const deadline = new Date(Date.parse(createdAt) + earlyDays * DAY).toISOString().slice(0, 10);
    if (deadline > dueDate) throw new Error("The discount window must end on or before the due date.");
  }
  if (!earlyBps && !lateBps) return null;
  return { earlyBps, earlyDays, lateBps };
}
