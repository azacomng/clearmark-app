// Receipts: one for every transaction, payments in and refunds out. Public by link (the
// underlying transfer is public onchain anyway) and re-verifiable against Arc from the browser.

import { CLASS_LABEL } from "./engine";
import { invoiceState, LedgerError } from "./ledger";
import { fmt } from "./money";
import type { Db, Hex } from "./types";

export function approvalMessage(r: { id: string; amount: string; to: string }) {
  return `Approve Clearmark refund ${r.id}\nAmount: ${fmt(r.amount)} USDC\nTo: ${r.to}\nNetwork: Arc Testnet`;
}

export interface ReceiptData {
  kind: "payment" | "refund";
  id: string;
  title: string;
  seal: string;
  amount: string;
  at: string;
  from: Hex;
  to: Hex;
  txHash: Hex;
  memoId: Hex | null;
  memoText: string | null;
  matchedBy: string;
  merchantName: string;
  invoice: { id: string; number: string; title: string; customerName: string; amount: string; label: string } | null;
  related: { label: string; href: string }[];
  note: string | null;
  source: "chain" | "demo";
  /** The stamp line, e.g. "Settled in 0.82s · final". Arc finality is deterministic, so "final" is literal. */
  settled: string;
  /** False when the merchant hides amounts on public share cards. */
  publicAmounts: boolean;
}

export function settledLine(settleMs: number | null | undefined): string {
  if (!settleMs) return "Final on Arc";
  const s = settleMs / 1000;
  return `Settled in ${s < 10 ? s.toFixed(2).replace(/0$/, "") : Math.round(s)}s · final`;
}

function termsNote(kind: string, price: string, amount: string): string {
  if (kind === "early") return ` Early-pay discount applied: ${fmt(price)} instead of ${fmt(amount)} USDC.`;
  if (kind === "late") return ` Paid after the due date, so the late fee applied: ${fmt(price)} USDC.`;
  return "";
}

export function receiptData(db: Db, kind: string, key: string): ReceiptData {
  if (kind === "p") {
    const id = key.replace(/-(\d+)$/, ":$1");
    const p = db.payments[id];
    if (!p) throw new LedgerError("Receipt not found", 404);
    const inv = p.invoiceId ? db.invoices[p.invoiceId] : undefined;
    const st = inv ? invoiceState(db, inv) : null;
    const cls = st?.payments.find((c) => c.id === p.id)?.cls;
    const held = !!p.hold && !p.hold.resolution;
    const refunds = Object.values(db.refunds).filter((r) => r.paymentId === p.id && r.status === "sent");
    const seal = held ? "HELD" : !inv ? "RECEIVED" : cls === "duplicate" ? "DUPLICATE" : cls === "over" || cls === "excess" ? "OVERPAID" : cls === "part" ? "PARTIAL" : cls === "short" ? "SHORT" : "PAID";
    return {
      kind: "payment",
      id: key,
      title: `${fmt(p.amount)} USDC received`,
      seal,
      amount: p.amount,
      at: p.timestamp,
      from: p.from,
      to: p.to,
      txHash: p.txHash,
      memoId: p.memoId,
      memoText: p.memoText,
      matchedBy: p.matchMethod === "memo" ? "Onchain memo · exact" : p.matchMethod === "manual" ? "Confirmed by merchant" : "Not matched yet",
      merchantName: db.merchants[p.merchant]?.name ?? "Merchant",
      invoice: inv && st ? { id: inv.id, number: inv.number, title: inv.title, customerName: inv.customerName, amount: inv.amount, label: st.label } : null,
      related: refunds.map((r) => ({ label: `Refund ${fmt(r.amount)} USDC`, href: `/r/f/${r.id}` })),
      note: held
        ? `Held for review: ${p.hold!.detail}`
        : cls
          ? `${CLASS_LABEL[cls]} on ${inv!.number}. Invoice is now ${st!.label}.${termsNote(st!.priceKind, st!.price, inv!.amount)}`
          : null,
      source: p.source,
      settled: settledLine(p.settleMs),
      publicAmounts: db.merchants[p.merchant]?.publicAmounts !== false,
    };
  }
  if (kind === "f") {
    const r = db.refunds[key];
    if (!r || r.status !== "sent" || !r.txHash) throw new LedgerError("Receipt not found", 404);
    const p = db.payments[r.paymentId];
    const inv = r.invoiceId ? db.invoices[r.invoiceId] : undefined;
    const st = inv ? invoiceState(db, inv) : null;
    const reason = { duplicate: "Duplicate payment returned", overpayment: "Overpayment returned", returned_hold: "Held payment returned", manual: "Refund" }[r.reason];
    return {
      kind: "refund",
      id: r.id,
      title: `${fmt(r.amount)} USDC refunded`,
      seal: "REFUND",
      amount: r.amount,
      at: r.sentAt!,
      from: r.merchant,
      to: r.to,
      txHash: r.txHash,
      memoId: r.memoId,
      memoText: null,
      matchedBy: reason,
      merchantName: db.merchants[r.merchant]?.name ?? "Merchant",
      invoice: inv && st ? { id: inv.id, number: inv.number, title: inv.title, customerName: inv.customerName, amount: inv.amount, label: st.label } : null,
      related: p ? [{ label: `Original payment ${fmt(p.amount)} USDC`, href: `/r/p/${p.id.replace(":", "-")}` }] : [],
      note: `${reason}. Sent from the merchant's wallet to the original payer.`,
      source: r.source,
      settled: settledLine(null),
      publicAmounts: db.merchants[r.merchant]?.publicAmounts !== false,
    };
  }
  throw new LedgerError("Receipt not found", 404);
}
