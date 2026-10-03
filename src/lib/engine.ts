// The reconciliation engine. Pure functions only: given an invoice and the payments
// matched to it, decide what each payment was and what state the invoice is in.
//
//   200 of 250            -> UNDERPAID     (balance 50 still due)
//   250                   -> PAID
//   249.70, tolerance .50 -> PAID · WITHIN TOLERANCE
//   300                   -> OVERPAID      (50 excess to refund or credit)
//   250 + 250             -> DUPLICATE     (second payment flagged for refund)
//   125 (part) + 125      -> PARTIAL, then PAID · SPLIT
//
// A short payment counts as "partial" (not "underpaid") only when the payer chose to pay
// part of a split invoice at checkout and the invoice is not yet overdue.

import { absDiff, big, str, sum, type Units } from "./money";
import type { Invoice, Payment } from "./types";

export type PaymentClass =
  | "exact" // single payment, exact amount
  | "tolerance" // single payment within the merchant's tolerance
  | "part" // declared part payment of a split invoice
  | "short" // short payment with no part-payment intent
  | "final_part" // the payment that completed a multi-payment invoice
  | "over" // the payment that pushed the invoice above amount + tolerance
  | "duplicate" // arrived after the invoice was covered, same amount again
  | "excess"; // arrived after the invoice was covered, a different amount

export type InvoiceStatus = "open" | "partial" | "underpaid" | "paid" | "overpaid" | "duplicate" | "void";
export type PaidVariant = null | "split" | "tolerance" | "written_off" | "refunded" | "credited";

export interface ClassifiedPayment {
  id: string;
  cls: PaymentClass;
  amount: Units;
  /** Amount of this payment that is excess or duplicate (needs a refund or credit). */
  surplus: Units;
}

export interface InvoiceState {
  status: InvoiceStatus;
  variant: PaidVariant;
  label: string;
  /** Total received on this invoice, duplicates included. */
  received: Units;
  /** Counted toward the invoice (duplicates and post-cover excess excluded). */
  counted: Units;
  balance: Units;
  /** Unresolved overpayment (excess) still awaiting a refund or credit. */
  excessOpen: Units;
  /** Unresolved duplicate amount still awaiting a refund or credit. */
  duplicateOpen: Units;
  writtenOff: Units;
  overdue: boolean;
  payments: ClassifiedPayment[];
}

export function countsTowardInvoice(p: Payment): boolean {
  return !p.hold || p.hold.resolution === "accepted";
}

export function sortPayments<T extends Pick<Payment, "blockNumber" | "logIndex" | "timestamp">>(ps: T[]): T[] {
  return [...ps].sort((a, b) => {
    const ba = big(a.blockNumber), bb = big(b.blockNumber);
    if (ba !== bb) return ba < bb ? -1 : 1;
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
    return a.timestamp.localeCompare(b.timestamp);
  });
}

export function reconcile(invoice: Invoice, allPayments: Payment[], now: Date = new Date()): InvoiceState {
  const A = big(invoice.amount);
  const T = big(invoice.tolerance);
  const lower = A - T > 0n ? A - T : 0n;
  const upper = A + T;
  const overdue = now.toISOString().slice(0, 10) > invoice.dueDate;

  const payments = sortPayments(allPayments.filter((p) => p.invoiceId === invoice.id && countsTowardInvoice(p)));

  let counted = 0n;
  let countedN = 0;
  let duplicateTotal = 0n;
  let excessAfterCover = 0n;
  const seenAmounts: bigint[] = [];
  const classified: ClassifiedPayment[] = [];

  for (const p of payments) {
    const amt = big(p.amount);
    let cls: PaymentClass;
    let surplus = 0n;
    if (countedN > 0 && counted >= lower) {
      const isDup = absDiff(amt, A) <= T || seenAmounts.some((s) => s === amt);
      cls = isDup ? "duplicate" : "excess";
      surplus = amt;
      if (isDup) duplicateTotal += amt;
      else excessAfterCover += amt;
    } else {
      counted += amt;
      countedN += 1;
      if (counted > upper) {
        cls = "over";
        surplus = counted - A;
      } else if (counted >= lower) {
        cls = countedN === 1 ? (amt === A ? "exact" : "tolerance") : "final_part";
      } else {
        cls = p.intent === "part" ? "part" : "short";
      }
    }
    seenAmounts.push(amt);
    classified.push({ id: p.id, cls, amount: p.amount, surplus: str(surplus) });
  }

  const received = sum(payments.map((p) => big(p.amount)));
  const clsById = new Map(classified.map((c) => [c.id, c.cls]));
  const res = invoice.resolutions;
  const writtenOff = sum(res.filter((r) => r.kind === "write_off").map((r) => big(r.amount)));
  const resolvedFor = (pred: (c: PaymentClass | undefined) => boolean) =>
    sum(res.filter((r) => r.kind !== "write_off" && r.paymentId && pred(clsById.get(r.paymentId))).map((r) => big(r.amount)));
  const dupResolved = resolvedFor((c) => c === "duplicate");
  const excessResolved = resolvedFor((c) => c === "over" || c === "excess");

  const overExcess = (counted > upper ? counted - A : 0n) + excessAfterCover;
  const excessOpen = max0(overExcess - excessResolved);
  const duplicateOpen = max0(duplicateTotal - dupResolved);
  const balance = max0(A - counted - writtenOff);

  let status: InvoiceStatus;
  let variant: PaidVariant = null;

  if (invoice.voided) {
    status = "void";
  } else if (payments.length === 0 && writtenOff === 0n) {
    status = "open";
  } else if (counted < lower) {
    if (counted + writtenOff >= lower) {
      status = "paid";
      variant = "written_off";
    } else if (classified.some((c) => c.cls === "short") || overdue) {
      status = "underpaid";
    } else {
      status = "partial";
    }
  } else if (duplicateOpen > 0n) {
    status = "duplicate";
  } else if (excessOpen > 0n) {
    status = "overpaid";
  } else {
    status = "paid";
    const kinds = new Set(res.map((r) => r.kind));
    if (kinds.has("refund")) variant = "refunded";
    else if (kinds.has("credit")) variant = "credited";
    else if (countedN > 1) variant = "split";
    else if (counted !== A) variant = "tolerance";
  }

  return {
    status,
    variant,
    label: label(status, variant),
    received: str(received),
    counted: str(counted),
    balance: str(balance),
    excessOpen: str(excessOpen),
    duplicateOpen: str(duplicateOpen),
    writtenOff: str(writtenOff),
    overdue: overdue && (status === "open" || status === "partial" || status === "underpaid"),
    payments: classified,
  };
}

function max0(x: bigint) {
  return x > 0n ? x : 0n;
}

export function label(status: InvoiceStatus, variant: PaidVariant): string {
  if (status !== "paid") {
    return {
      open: "OPEN",
      partial: "PARTIAL",
      underpaid: "UNDERPAID",
      overpaid: "OVERPAID",
      duplicate: "DUPLICATE",
      void: "VOID",
    }[status];
  }
  if (!variant) return "PAID";
  return {
    split: "PAID · SPLIT",
    tolerance: "PAID · WITHIN TOLERANCE",
    written_off: "PAID · WRITTEN OFF",
    refunded: "PAID · REFUNDED",
    credited: "PAID · CREDITED",
  }[variant];
}

export const CLASS_LABEL: Record<PaymentClass, string> = {
  exact: "Exact payment",
  tolerance: "Within tolerance",
  part: "Part payment",
  short: "Short payment",
  final_part: "Final part",
  over: "Overpayment",
  duplicate: "Duplicate",
  excess: "Extra payment",
};

/** CSS class for a status pill, matching the concept page palette. */
export function pillClass(status: InvoiceStatus | "review" | "refund" | "held"): string {
  return (
    {
      open: "s-open",
      partial: "s-partial",
      underpaid: "s-under",
      paid: "s-paid",
      overpaid: "s-over",
      duplicate: "s-dup",
      void: "s-open",
      review: "s-review",
      held: "s-review",
      refund: "s-over",
    } as const
  )[status];
}
