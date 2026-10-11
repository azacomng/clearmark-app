// What Clearmark hands to an accounting system, worked out once and used by both the file exports
// and the live sync, so the two always agree.
//
// An invoice goes over as one line at its face amount. Once it is settled, extra lines bring its total
// to exactly what was received toward it (early-pay discount, late fee, tolerance, write-off), so the
// payments close it in the books. Duplicates and overpayments are not invoice income and stay out;
// they appear in the transactions file as money in, with their refunds as money out.
//
// Stablecoins are booked in their fiat currency 1:1: USDC as USD, EURC as EUR.

import { reconcile } from "../engine";
import { currencyOf, tokenOf } from "../fx";
import { merchantInvoices, merchantPayments } from "../ledger";
import { big, fmt } from "../money";
import { historyRows } from "../service";
import type { Token } from "../arc";
import type { Currency, Db, Hex, Invoice } from "../types";

export type Fiat = "USD" | "EUR";
export const fiatOf = (c: Currency): Fiat => (c === "EUR" ? "EUR" : "USD");
export const fiatOfToken = (t: Token): Fiat => (t === "EURC" ? "EUR" : "USD");

/**
 * Accounting tools work in cents, so every amount is rounded to 2 decimals (half away from zero) here,
 * once, and totals are built from the rounded figures.
 */
export const cents = (u: bigint): bigint => {
  const c = 10_000n;
  const r = (u < 0n ? -u : u) + c / 2n;
  return (u < 0n ? -1n : 1n) * (r - (r % c));
};

/** Amount in 6-decimal units as a plain decimal string for accounting tools: "1234.5" -> "1234.50". */
export const money = (u: bigint | string) => fmt(u).replace(/,/g, "");

export interface BookLine {
  description: string;
  /** Units (6 decimals). Negative for discounts and write-offs. */
  amount: bigint;
}

export interface BookPayment {
  id: string;
  date: string; // YYYY-MM-DD
  /** Amount applied to the invoice, in invoice units. */
  amount: bigint;
  token: Token;
  txHash: string;
}

export interface BookInvoice {
  id: string;
  number: string;
  customerName: string;
  customerEmail: string | null;
  issueDate: string; // YYYY-MM-DD
  dueDate: string;
  currency: Fiat;
  title: string;
  lines: BookLine[];
  total: bigint;
  voided: boolean;
  settled: boolean;
  payments: BookPayment[];
  paymentLink: string;
}

const SETTLED = new Set(["paid", "overpaid", "duplicate"]);

export function bookInvoice(db: Db, inv: Invoice, origin: string, now = new Date()): BookInvoice {
  // Simulated payments never reach the books.
  const real = merchantPayments(db, inv.merchant).filter((p) => p.source !== "demo");
  const st = reconcile(inv, real, now);
  const face = big(inv.amount);
  const lines: BookLine[] = [{ description: inv.title, amount: cents(face) }];
  const payments: BookPayment[] = [];
  for (const c of st.payments) {
    const applied = big(c.amount) - big(c.surplus);
    if (applied <= 0n) continue;
    const p = db.payments[c.id];
    const amount = cents(applied);
    if (amount > 0n) payments.push({ id: c.id, date: p.timestamp.slice(0, 10), amount, token: tokenOf(p), txHash: p.txHash });
  }
  const settled = !inv.voided && SETTLED.has(st.status);
  if (settled) {
    // Settled: the lines must add up to exactly what was applied, in cents, so the invoice closes.
    const price = cents(big(st.price));
    const applied = payments.reduce((a, p) => a + p.amount, 0n);
    const writtenOff = cents(big(st.writtenOff));
    if (price !== lines[0].amount) lines.push({ description: price < lines[0].amount ? "Early-payment discount" : "Late fee", amount: price - lines[0].amount });
    if (writtenOff > 0n) lines.push({ description: "Written off in Clearmark", amount: -writtenOff });
    const rest = applied - lines.reduce((a, l) => a + l.amount, 0n);
    if (rest !== 0n) lines.push({ description: "Accepted within payment tolerance", amount: rest });
  }
  return {
    id: inv.id,
    number: inv.number,
    customerName: inv.customerName,
    customerEmail: inv.customerEmail,
    issueDate: inv.createdAt.slice(0, 10),
    dueDate: inv.dueDate,
    currency: fiatOf(currencyOf(inv)),
    title: inv.title,
    lines,
    total: lines.reduce((a, l) => a + l.amount, 0n),
    voided: inv.voided,
    settled,
    payments,
    paymentLink: `${origin}/pay/${inv.id}`,
  };
}

export function bookInvoices(db: Db, merchant: Hex, origin: string, now = new Date()): BookInvoice[] {
  return merchantInvoices(db, merchant)
    .map((inv) => bookInvoice(db, inv, origin, now))
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
}

export interface BookTxn {
  date: string;
  /** Signed units: money in is positive. */
  amount: bigint;
  payee: string;
  description: string;
  reference: string;
  token: Token;
}

/** Every real transfer in and out of the merchant's wallet, as a bank statement for one token. */
export function bookTransactions(db: Db, merchant: Hex, token: Token, now = new Date()): BookTxn[] {
  return historyRows(db, merchant, now)
    .filter((r) => r.source !== "demo" && r.token === token)
    .map((r) => {
      const type = r.kind === "in" ? "Payment received" : r.status === "PAYOUT" ? "Payout" : "Refund";
      return {
        date: r.at.slice(0, 10),
        amount: cents(big(r.amount)),
        payee: r.counterparty,
        description: [type, r.invoiceNumber, r.kind === "in" ? r.status : null].filter(Boolean).join(" · "),
        reference: r.txHash ?? "",
        token,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

