// Tier-3 matching: a transfer arrived without a Clearmark memo (for example, sent from an
// exchange). Score the merchant's open invoices and suggest the best match for one-click review.

import { absDiff, big } from "./money";
import { reconcile } from "./engine";
import type { Invoice, Payment } from "./types";

export interface Suggestion {
  invoiceId: string;
  number: string;
  customerName: string;
  confidence: number; // 0-100
  reasons: string[];
}

export function suggestMatches(
  payment: Payment,
  invoices: Invoice[],
  payments: Payment[],
  now: Date = new Date(),
): Suggestion[] {
  const amt = big(payment.amount);
  const out: Suggestion[] = [];
  for (const inv of invoices) {
    if (inv.voided || inv.merchant !== payment.merchant) continue;
    const st = reconcile(inv, payments, now);
    if (!["open", "partial", "underpaid"].includes(st.status)) continue;
    const bal = big(st.balance);
    const tol = big(inv.tolerance);
    let score = 0;
    const reasons: string[] = [];
    if (amt === bal) {
      score += 60;
      reasons.push("amount matches the balance exactly");
    } else if (absDiff(amt, bal) <= tol) {
      score += 50;
      reasons.push("amount within tolerance of the balance");
    } else if (amt < bal) {
      score += 15;
      reasons.push("could be a part payment");
    } else {
      continue;
    }
    const knownPayer = payments.some(
      (p) => p.id !== payment.id && p.from === payment.from && p.invoiceId &&
        invoices.find((i) => i.id === p.invoiceId)?.customerName.toLowerCase() === inv.customerName.toLowerCase(),
    );
    if (knownPayer) {
      score += 30;
      reasons.push(`this wallet has paid ${inv.customerName} invoices before`);
    }
    const days = Math.abs(Date.parse(inv.dueDate) - Date.parse(payment.timestamp)) / 86_400_000;
    if (days <= 7) {
      score += 9;
      reasons.push("sent within a week of the due date");
    }
    out.push({ invoiceId: inv.id, number: inv.number, customerName: inv.customerName, confidence: Math.min(99, score), reasons });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}
