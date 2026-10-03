// Currency helpers. Reconciliation always happens in the invoice's currency:
//   USDC invoice  <- USDC 1:1
//   EUR invoice   <- EURC 1:1, or USDC converted at the rate quoted to the payer at checkout
// Rates are EUR units per 1 USDC, scaled by 1e6 (0.92 EUR = "920000").

import type { Token } from "./arc";
import type { Currency, Invoice, Payment } from "./types";

export const RATE_SCALE = 1_000_000n;

export const currencyOf = (inv: Pick<Invoice, "currency">): Currency => inv.currency ?? "USDC";
export const tokenOf = (p: Pick<Payment, "token">): Token => p.token ?? "USDC";

/** The token that settles an invoice currency 1:1. */
export const nativeToken = (c: Currency): Token => (c === "EUR" ? "EURC" : "USDC");

/** Short unit label for amounts in invoice units. */
export const unitOf = (inv: Pick<Invoice, "currency">) => (currencyOf(inv) === "EUR" ? "EUR" : "USDC");

/** True when a payment in `token` must be converted to count toward an invoice in `currency`. */
export const needsFx = (currency: Currency, token: Token) => nativeToken(currency) !== token;

/** Convert token units to invoice units at `rate` (rounded down, in the payer's disfavour by < 1 unit). */
export const toInvoiceUnits = (amount: bigint, rate: bigint) => (amount * rate) / RATE_SCALE;

/** Token units needed to cover `invoiceUnits` at `rate` (rounded up, so the payer never falls short). */
export const toTokenUnits = (invoiceUnits: bigint, rate: bigint) => (invoiceUnits * RATE_SCALE + rate - 1n) / rate;

/**
 * What a payment is worth on its invoice, in invoice units. A mismatched payment without a rate
 * is held for review on arrival (fx_missing), so the amount is only a fallback here.
 */
export function paymentValue(inv: Pick<Invoice, "currency">, p: Pick<Payment, "amount" | "token" | "fx">): bigint {
  const amt = BigInt(p.amount);
  if (!needsFx(currencyOf(inv), tokenOf(p))) return amt;
  return p.fx ? toInvoiceUnits(amt, BigInt(p.fx.rate)) : amt;
}

/** "1 USDC = 0.9213 EUR" */
export function rateLine(rate: string | bigint): string {
  const r = Number(BigInt(rate)) / 1e6;
  return `1 USDC = ${r.toFixed(4)} EUR`;
}
