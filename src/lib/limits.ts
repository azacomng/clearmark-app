// Transaction limits. Nobody can stop a stranger from sending USDC to an address, so limits
// are enforced where Clearmark controls the flow: its own checkout links and refunds.
// Anything that arrives outside the limits is held for review, never silently booked.

import { big, fmt, sum } from "./money";
import type { Hold, Limits, Payment } from "./types";

export const DEFAULT_LIMITS: Limits = {
  maxPerPayment: "5000000000", // 5,000 USDC
  dailyCap: "20000000000", // 20,000 USDC
  perCustomerMonthlyCap: null,
  refundApprovalAbove: "500000000", // 500 USDC
};

const day = (iso: string) => iso.slice(0, 10);
const month = (iso: string) => iso.slice(0, 7);

/** Inbound already counted against limits (held payments that were not accepted don't count). */
function counting(ps: Payment[]) {
  return ps.filter((p) => !p.hold || p.hold.resolution === "accepted");
}

export function receivedToday(ps: Payment[], at: string): bigint {
  return sum(counting(ps).filter((p) => day(p.timestamp) === day(at)).map((p) => big(p.amount)));
}

export function receivedFromThisMonth(ps: Payment[], from: string, at: string): bigint {
  return sum(
    counting(ps)
      .filter((p) => p.from.toLowerCase() === from.toLowerCase() && month(p.timestamp) === month(at))
      .map((p) => big(p.amount)),
  );
}

/** Decide whether an incoming payment should be held. `existing` are the merchant's other payments. */
export function inboundHold(
  limits: Limits,
  p: Pick<Payment, "amount" | "from" | "timestamp">,
  existing: Payment[],
): Hold | null {
  const amt = big(p.amount);
  if (limits.maxPerPayment && amt > big(limits.maxPerPayment)) {
    return {
      reason: "over_max",
      detail: `${fmt(amt)} USDC is above your ${fmt(limits.maxPerPayment)} USDC max per payment.`,
      resolution: null,
    };
  }
  if (limits.dailyCap) {
    const today = receivedToday(existing, p.timestamp);
    if (today + amt > big(limits.dailyCap)) {
      return {
        reason: "daily_cap",
        detail: `This takes today to ${fmt(today + amt)} USDC, past your ${fmt(limits.dailyCap)} USDC daily cap.`,
        resolution: null,
      };
    }
  }
  if (limits.perCustomerMonthlyCap) {
    const m = receivedFromThisMonth(existing, p.from, p.timestamp);
    if (m + amt > big(limits.perCustomerMonthlyCap)) {
      return {
        reason: "customer_cap",
        detail: `This payer would reach ${fmt(m + amt)} USDC this month, over the ${fmt(limits.perCustomerMonthlyCap)} USDC per-customer cap.`,
        resolution: null,
      };
    }
  }
  return null;
}

export interface CheckoutCheck {
  ok: boolean;
  /** Largest amount the checkout will accept right now (null = no limit beyond the balance). */
  maxAmount: bigint | null;
  reason: string | null;
}

/** What the checkout link may accept for a given amount, before the payer signs anything. */
export function checkoutCheck(
  limits: Limits,
  amount: bigint,
  existing: Payment[],
  now: string,
  from?: string | null,
): CheckoutCheck {
  const caps: { cap: bigint; why: string }[] = [];
  if (limits.maxPerPayment) caps.push({ cap: big(limits.maxPerPayment), why: "the merchant's max per payment" });
  if (limits.dailyCap) {
    const left = big(limits.dailyCap) - receivedToday(existing, now);
    caps.push({ cap: left > 0n ? left : 0n, why: "the merchant's daily limit" });
  }
  if (limits.perCustomerMonthlyCap && from) {
    const left = big(limits.perCustomerMonthlyCap) - receivedFromThisMonth(existing, from, now);
    caps.push({ cap: left > 0n ? left : 0n, why: "the merchant's monthly limit for this wallet" });
  }
  if (caps.length === 0) return { ok: true, maxAmount: null, reason: null };
  const tightest = caps.reduce((a, b) => (b.cap < a.cap ? b : a));
  if (tightest.cap === 0n) {
    return { ok: false, maxAmount: 0n, reason: `This link is paused: ${tightest.why} has been reached. Try again later.` };
  }
  if (amount > tightest.cap) {
    return {
      ok: false,
      maxAmount: tightest.cap,
      reason: `${fmt(amount)} USDC is above ${tightest.why}. You can pay up to ${fmt(tightest.cap)} USDC now.`,
    };
  }
  return { ok: true, maxAmount: tightest.cap, reason: null };
}

export function refundNeedsApproval(limits: Limits, amount: bigint): boolean {
  return !!limits.refundApprovalAbove && amount > big(limits.refundApprovalAbove);
}
