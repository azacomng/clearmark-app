// Server-side use cases: everything an API route needs, combining the store, the chain and
// the ledger. Routes stay thin; money rules live in ledger.ts / engine.ts / limits.ts.

import "server-only";
import { keccak256, stringToHex } from "viem";
import { read, write } from "./store";
import { latestBlock, scanInbound, verifyTx } from "./chain";
import { CLASS_LABEL, pillClass, type InvoiceState } from "./engine";
import {
  ensureMerchant,
  invoicePayouts,
  invoiceState,
  markPayoutSent,
  payoutPlan,
  unconvertedUsdc,
  LedgerError,
  merchantInvoices,
  merchantPayments,
  recordTransfer,
  markRefundSent,
  type IncomingTransfer,
} from "./ledger";
import { checkoutCheck } from "./limits";
import { earlyDeadline, termsLine } from "./terms";
import { currencyOf, nativeToken, rateLine, tokenOf, unitOf } from "./fx";
import { eurPerUsdc } from "./rates";
import { suggestMatches } from "./matching";
import { big, fmt, str, sum } from "./money";
import type { Db, Hex, Invoice, Payment, Payout, Refund } from "./types";

export const DEMO = process.env.CLEARMARK_DEMO === "1";

export const paymentKey = (p: Pick<Payment, "id">) => p.id.replace(":", "-");
export const keyToPaymentId = (k: string) => k.replace(/-(\d+)$/, ":$1");

export async function signInMerchant(address: Hex) {
  let start: bigint | null = null;
  try {
    start = await latestBlock();
  } catch {
    /* RPC unreachable: the first successful sync sets the start block */
  }
  return write((db) => ensureMerchant(db, address, new Date(), start));
}

// ---------- views ----------

export function invoiceView(db: Db, inv: Invoice, now = new Date()) {
  const state = invoiceState(db, inv, now);
  const unit = unitOf(inv);
  const plan = inv.splits?.length ? payoutPlan(db, inv, now) : null;
  return {
    ...inv,
    currency: currencyOf(inv),
    unit,
    splits: inv.splits ?? [],
    state,
    pill: pillClass(state.status),
    termsLine: termsLine(inv, unit),
    earlyDeadline: earlyDeadline(inv),
    payouts: invoicePayouts(db, inv.id),
    payoutPlan: plan ? { base: str(plan.base), token: plan.token, lines: plan.lines } : null,
    unconvertedUsdc: str(unconvertedUsdc(db, inv)),
  };
}
export type InvoiceView = ReturnType<typeof invoiceView>;

function customerFor(db: Db, p: Payment) {
  const inv = p.invoiceId ? db.invoices[p.invoiceId] : undefined;
  return inv?.customerName ?? null;
}

export function paymentView(db: Db, p: Payment, now = new Date()) {
  const inv = p.invoiceId ? db.invoices[p.invoiceId] : undefined;
  const st = inv ? invoiceState(db, inv, now) : null;
  const cls = st?.payments.find((c) => c.id === p.id) ?? null;
  const resolved = inv ? sum(inv.resolutions.filter((r) => r.paymentId === p.id).map((r) => big(r.amount))) : 0n;
  const surplusOpen = cls ? big(cls.surplus) - resolved : 0n;
  return {
    ...p,
    key: paymentKey(p),
    invoiceNumber: inv?.number ?? null,
    customerName: inv?.customerName ?? null,
    token: tokenOf(p),
    /** Value toward the invoice, in invoice units (differs from amount only with FX). */
    value: cls?.amount ?? p.amount,
    unit: inv ? unitOf(inv) : tokenOf(p),
    cls: cls?.cls ?? null,
    clsLabel: cls ? CLASS_LABEL[cls.cls] : null,
    surplus: cls?.surplus ?? "0",
    surplusOpen: str(surplusOpen > 0n ? surplusOpen : 0n),
    invoiceLabel: st?.label ?? null,
  };
}
export type PaymentView = ReturnType<typeof paymentView>;

export interface HistoryRow {
  kind: "in" | "out";
  id: string;
  receipt: string;
  at: string;
  counterparty: string;
  address: Hex;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: string;
  pill: string;
  flagged: boolean;
  amount: string; // signed units
  token: "USDC" | "EURC";
  txHash: Hex | null;
  source: "chain" | "demo";
}

function rowStatus(v: PaymentView): { status: string; pill: string; flagged: boolean } {
  if (v.hold && !v.hold.resolution) return { status: "HELD", pill: "s-review", flagged: true };
  if (v.hold?.resolution === "returned") return { status: "RETURNED", pill: "s-over", flagged: false };
  if (!v.invoiceId) return { status: "NEEDS REVIEW", pill: "s-review", flagged: true };
  const map: Record<string, [string, string, boolean]> = {
    exact: ["PAID", "s-paid", false],
    tolerance: ["PAID · TOLERANCE", "s-paid", false],
    final_part: ["PAID · SPLIT", "s-paid", false],
    part: ["PARTIAL", "s-partial", false],
    short: ["UNDERPAID", "s-under", true],
    over: ["OVERPAID", "s-over", true],
    duplicate: ["DUPLICATE", "s-dup", true],
    excess: ["EXTRA", "s-over", true],
  };
  const [status, pill, flagged] = map[v.cls ?? "exact"];
  if (flagged && big(v.surplus) > 0n && big(v.surplusOpen) === 0n) return { status: `${status} · SETTLED`, pill: "s-paid", flagged: false };
  return { status, pill, flagged };
}

export function historyRows(db: Db, merchant: Hex, now = new Date()): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const p of merchantPayments(db, merchant)) {
    const v = paymentView(db, p, now);
    const s = rowStatus(v);
    rows.push({
      kind: "in",
      id: p.id,
      receipt: `/r/p/${v.key}`,
      at: p.timestamp,
      counterparty: customerFor(db, p) ?? "Unknown sender",
      address: p.from,
      invoiceId: p.invoiceId,
      invoiceNumber: v.invoiceNumber,
      ...s,
      amount: p.amount,
      token: tokenOf(p),
      txHash: p.txHash,
      source: p.source,
    });
  }
  for (const r of Object.values(db.refunds)) {
    if (r.merchant !== merchant || r.status !== "sent") continue;
    const p = db.payments[r.paymentId];
    rows.push({
      kind: "out",
      id: r.id,
      receipt: `/r/f/${r.id}`,
      at: r.sentAt ?? r.createdAt,
      counterparty: (p && customerFor(db, p)) ?? "Original payer",
      address: r.to,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceId ? db.invoices[r.invoiceId]?.number ?? null : null,
      status: "REFUND",
      pill: "s-over",
      flagged: false,
      amount: str(-big(r.amount)),
      token: r.token ?? "USDC",
      txHash: r.txHash,
      source: r.source,
    });
  }
  for (const po of Object.values(db.payouts ?? {})) {
    if (po.merchant !== merchant || po.status !== "sent") continue;
    const inv = db.invoices[po.invoiceId];
    po.lines.forEach((l, i) =>
      rows.push({
        kind: "out",
        id: `${po.id}.${i}`,
        receipt: `/r/s/${po.id}.${i}`,
        at: po.sentAt ?? po.createdAt,
        counterparty: l.label,
        address: l.address,
        invoiceId: po.invoiceId,
        invoiceNumber: inv?.number ?? null,
        status: "PAYOUT",
        pill: "s-partial",
        flagged: false,
        amount: str(-big(l.amount)),
        token: po.token,
        txHash: po.txHash,
        source: po.source,
      }),
    );
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export function dashboard(db: Db, merchant: Hex, now = new Date()) {
  const m = db.merchants[merchant];
  const invoices = merchantInvoices(db, merchant).map((i) => invoiceView(db, i, now));
  const payments = merchantPayments(db, merchant);
  const month = now.toISOString().slice(0, 7);
  const counted = payments.filter((p) => !p.hold || p.hold.resolution === "accepted");
  const thisMonth = counted.filter((p) => p.timestamp.startsWith(month));
  const receivedMonth = sum(thisMonth.filter((p) => tokenOf(p) === "USDC").map((p) => big(p.amount)));
  const receivedMonthEurc = sum(thisMonth.filter((p) => tokenOf(p) === "EURC").map((p) => big(p.amount)));
  const tagged = payments.filter((p) => p.matchMethod === "memo").length;
  const outstanding = invoices.filter((i) => ["open", "partial", "underpaid"].includes(i.state.status));
  const review = reviewItems(db, merchant, now);
  const refundsSent = Object.values(db.refunds).filter((r) => r.merchant === merchant && r.status === "sent");
  const credits = sum(invoices.flatMap((i) => i.resolutions.filter((r) => r.kind === "credit").map((r) => big(r.amount))));
  return {
    merchant: m,
    demo: DEMO,
    kpis: {
      receivedMonth: str(receivedMonth),
      receivedMonthEurc: str(receivedMonthEurc),
      paymentsMonth: counted.filter((p) => p.timestamp.startsWith(month)).length,
      autoMatched: payments.length ? Math.round((tagged / payments.length) * 1000) / 10 : null,
      autoMatchedOf: [tagged, payments.length],
      outstanding: str(sum(outstanding.map((i) => big(i.state.balance)))),
      outstandingCount: outstanding.length,
      overdueCount: outstanding.filter((i) => i.state.overdue).length,
      reviewCount: review.count,
      refunded: str(sum(refundsSent.map((r) => big(r.amount)))),
      credits: str(credits),
    },
    invoices,
  };
}

export function reviewItems(db: Db, merchant: Hex, now = new Date()) {
  const all = merchantPayments(db, merchant);
  const invoices = merchantInvoices(db, merchant);
  const unmatched = all
    .filter((p) => !p.invoiceId && !(p.hold && p.hold.resolution === "returned"))
    .map((p) => ({ ...paymentView(db, p, now), suggestions: suggestMatches(p, invoices, all, now) }));
  const held = all.filter((p) => p.hold && !p.hold.resolution && p.invoiceId).map((p) => paymentView(db, p, now));
  const actionable = invoices
    .map((i) => invoiceView(db, i, now))
    .filter((i) => ["duplicate", "overpaid", "underpaid"].includes(i.state.status));
  const refunds = Object.values(db.refunds)
    .filter((r) => r.merchant === merchant && r.status !== "sent")
    .map((r) => refundView(db, r));
  // Unmatched payments that are also held appear once, under unmatched.
  return {
    unmatched,
    held,
    invoices: actionable,
    refunds,
    count: unmatched.length + held.length + actionable.length + refunds.length,
  };
}

export function refundView(db: Db, r: Refund) {
  const inv = r.invoiceId ? db.invoices[r.invoiceId] : undefined;
  return { ...r, invoiceNumber: inv?.number ?? null, customerName: inv?.customerName ?? null };
}

/** What a customer sees at the payment link. No merchant-private data. */
export function publicInvoice(db: Db, inv: Invoice, now = new Date()) {
  const m = db.merchants[inv.merchant];
  const st: InvoiceState = invoiceState(db, inv, now);
  const balance = big(st.balance);
  const check = checkoutCheck(m.limits, balance > 0n ? balance : big(inv.amount), merchantPayments(db, inv.merchant), now.toISOString());
  const payments = merchantPayments(db, inv.merchant)
    .filter((p) => p.invoiceId === inv.id)
    .map((p) => paymentView(db, p, now))
    .map((p) => ({ key: p.key, amount: p.amount, token: p.token, timestamp: p.timestamp, txHash: p.txHash, clsLabel: p.clsLabel, held: !!p.hold && !p.hold.resolution, source: p.source }));
  return {
    id: inv.id,
    number: inv.number,
    title: inv.title,
    customerName: inv.customerName,
    amount: inv.amount,
    tolerance: inv.tolerance,
    dueDate: inv.dueDate,
    allowSplit: inv.allowSplit,
    currency: currencyOf(inv),
    unit: unitOf(inv),
    token: nativeToken(currencyOf(inv)),
    terms: inv.terms ?? null,
    termsLine: termsLine(inv, unitOf(inv)),
    earlyDeadline: earlyDeadline(inv),
    memoId: inv.memoId,
    voided: inv.voided,
    merchant: { address: m.address, name: m.name },
    state: { status: st.status, label: st.label, balance: st.balance, received: st.received, counted: st.counted, price: st.price, priceKind: st.priceKind, pill: pillClass(st.status) },
    checkout: { ok: check.ok, maxAmount: check.maxAmount === null ? null : str(check.maxAmount), reason: check.reason },
    payments,
    demo: DEMO,
  };
}
export type PublicInvoice = ReturnType<typeof publicInvoice>;

// ---------- chain ingestion ----------

export async function confirmTx(txHash: Hex) {
  const v = await verifyTx(txHash);
  if (!v) throw new LedgerError("That transaction isn't on Arc testnet yet. Try again in a moment.", 404);
  if (v.status !== "success") throw new LedgerError("That transaction reverted, so no USDC moved.");
  const now = new Date();
  return write((db) =>
    v.transfers
      .map((t) => recordTransfer(db, { ...t, source: "chain", timestamp: v.timestamp } satisfies IncomingTransfer, now))
      .filter(Boolean) as Payment[],
  );
}

export async function syncMerchant(merchant: Hex) {
  const db = await read();
  const m = db.merchants[merchant];
  if (!m) throw new LedgerError("Merchant not found", 404);
  try {
    if (!m.startBlock) {
      const head = await latestBlock();
      await write((d) => {
        d.merchants[merchant].startBlock = head.toString();
        d.merchants[merchant].lastSyncedBlock = head.toString();
        d.merchants[merchant].lastSyncAt = new Date().toISOString();
        d.merchants[merchant].lastSyncError = null;
      });
      return { added: 0, syncedTo: head.toString(), behind: false };
    }
    const after = BigInt(m.lastSyncedBlock ?? BigInt(m.startBlock) - 1n);
    const scan = await scanInbound(merchant, after);
    const now = new Date();
    const added = await write((d) => {
      let n = 0;
      for (const t of scan.transfers) {
        const before = Object.keys(d.payments).length;
        recordTransfer(d, { ...t, source: "chain" }, now);
        if (Object.keys(d.payments).length > before) n++;
      }
      const mm = d.merchants[merchant];
      mm.lastSyncedBlock = scan.syncedTo.toString();
      mm.lastSyncAt = now.toISOString();
      mm.lastSyncError = null;
      return n;
    });
    return { added, syncedTo: scan.syncedTo.toString(), behind: scan.syncedTo < scan.head };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "Sync failed";
    await write((d) => {
      d.merchants[merchant].lastSyncError = msg;
      d.merchants[merchant].lastSyncAt = new Date().toISOString();
    });
    return { added: 0, syncedTo: m.lastSyncedBlock, behind: true, error: msg };
  }
}

export async function confirmRefundTx(merchant: Hex, refundId: string, txHash: Hex) {
  const v = await verifyTx(txHash);
  if (!v) throw new LedgerError("That transaction isn't on Arc testnet yet. Try again in a moment.", 404);
  if (v.status !== "success") throw new LedgerError("That transaction reverted, so no USDC moved.");
  return write((db) => {
    const r = db.refunds[refundId];
    if (!r || r.merchant !== merchant) throw new LedgerError("Refund not found", 404);
    const tok = r.token ?? "USDC";
    const t = v.transfers.find((x) => x.from === merchant && x.to === r.to && x.token === tok) ?? v.transfers.find((x) => x.from === merchant && x.to === r.to) ?? v.transfers[0];
    if (!t) throw new LedgerError("That transaction has no USDC transfer.");
    return markRefundSent(db, merchant, refundId, { ...t, timestamp: v.timestamp });
  });
}

export async function confirmPayoutTx(merchant: Hex, payoutId: string, txHash: Hex): Promise<Payout> {
  const v = await verifyTx(txHash);
  if (!v) throw new LedgerError("That transaction isn't on Arc testnet yet. Try again in a moment.", 404);
  if (v.status !== "success") throw new LedgerError("That transaction reverted, so nothing was paid.");
  return write((db) => markPayoutSent(db, merchant, payoutId, { txHash, blockNumber: v.blockNumber, timestamp: v.timestamp, transfers: v.transfers }));
}

/** The live EUR/USDC rate, for display and quotes. */
export async function currentRate() {
  const r = await eurPerUsdc();
  return r ? { rate: r.rate.toString(), source: r.source, line: rateLine(r.rate) } : null;
}

// ---------- demo mode ----------

let demoCounter = 0;
export function demoTxHash(seed: string): Hex {
  return keccak256(stringToHex(`clearmark-demo:${seed}:${Date.now()}:${demoCounter++}`));
}

export function fmtUsdc(u: string) {
  return fmt(u);
}
