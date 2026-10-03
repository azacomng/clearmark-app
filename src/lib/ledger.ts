// Ledger operations on the in-memory Db. No I/O here: the service layer loads the Db,
// calls these, and saves. That keeps every money rule unit-testable.

import { invoiceMemoId, parseMemoText, refundMemoId } from "./arc";
import { reconcile, type InvoiceState } from "./engine";
import { DEFAULT_LIMITS, inboundHold, refundNeedsApproval } from "./limits";
import { big, fmt, str, toUnits } from "./money";
import type { Db, Hex, Invoice, Limits, Merchant, Payment, Refund, Resolution } from "./types";

export class LedgerError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function rid(prefix = "", bytes = 8): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return prefix + n.toString(36);
}

export function ensureMerchant(db: Db, address: Hex, now: Date, startBlock: bigint | null): Merchant {
  const a = address.toLowerCase() as Hex;
  db.merchants[a] ??= {
    address: a,
    name: "My business",
    createdAt: now.toISOString(),
    startBlock: startBlock === null ? null : startBlock.toString(),
    lastSyncedBlock: null,
    lastSyncAt: null,
    lastSyncError: null,
    nextInvoiceNo: 10001,
    limits: { ...DEFAULT_LIMITS },
  };
  return db.merchants[a];
}

export function getMerchant(db: Db, address: Hex): Merchant {
  const m = db.merchants[address.toLowerCase()];
  if (!m) throw new LedgerError("Merchant not found", 404);
  return m;
}

export interface NewInvoice {
  title: string;
  customerName: string;
  customerEmail?: string | null;
  amount: string;
  tolerance?: string;
  dueDate: string;
  allowSplit?: boolean;
}

export function createInvoice(db: Db, merchantAddr: Hex, input: NewInvoice, now: Date): Invoice {
  const m = getMerchant(db, merchantAddr);
  const title = input.title?.trim();
  const customerName = input.customerName?.trim();
  if (!title) throw new LedgerError("Add what the invoice is for.");
  if (!customerName) throw new LedgerError("Add the customer's name.");
  let amount: bigint, tolerance: bigint;
  try {
    amount = toUnits(input.amount);
    tolerance = toUnits(input.tolerance || "0");
  } catch (e) {
    throw new LedgerError((e as Error).message);
  }
  if (amount <= 0n) throw new LedgerError("The amount must be more than zero.");
  if (tolerance * 10n > amount) throw new LedgerError("Tolerance can be at most 10% of the amount.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new LedgerError("Pick a due date.");
  const allowSplit = !!input.allowSplit;
  if (m.limits.maxPerPayment && amount > big(m.limits.maxPerPayment) && !allowSplit) {
    throw new LedgerError(
      `This is above your ${fmt(m.limits.maxPerPayment)} USDC max per payment. Turn on split payments or raise the limit.`,
    );
  }
  const id = rid("", 7);
  const inv: Invoice = {
    id,
    merchant: m.address,
    number: `INV-${m.nextInvoiceNo++}`,
    title: title.slice(0, 120),
    customerName: customerName.slice(0, 80),
    customerEmail: input.customerEmail?.trim() || null,
    amount: str(amount),
    tolerance: str(tolerance),
    dueDate: input.dueDate,
    allowSplit,
    memoId: invoiceMemoId(id),
    createdAt: now.toISOString(),
    voided: false,
    resolutions: [],
  };
  db.invoices[id] = inv;
  return inv;
}

export function merchantPayments(db: Db, merchant: Hex): Payment[] {
  return Object.values(db.payments).filter((p) => p.merchant === merchant);
}

export function merchantInvoices(db: Db, merchant: Hex): Invoice[] {
  return Object.values(db.invoices)
    .filter((i) => i.merchant === merchant)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function invoiceState(db: Db, inv: Invoice, now = new Date()): InvoiceState {
  return reconcile(inv, merchantPayments(db, inv.merchant), now);
}

export interface IncomingTransfer {
  source: "chain" | "demo";
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  timestamp: string;
  from: Hex;
  to: Hex;
  amount: bigint;
  memoId: Hex | null;
  memoData: Hex | null;
}

/**
 * Record one inbound USDC transfer to a merchant. Idempotent on (txHash, logIndex).
 * Matches it to an invoice by memo, then applies the merchant's limits.
 */
export function recordTransfer(db: Db, t: IncomingTransfer, now: Date): Payment | null {
  const to = t.to.toLowerCase() as Hex;
  const m = db.merchants[to];
  if (!m || t.amount <= 0n) return null;
  if (t.from.toLowerCase() === to) return null; // self-transfer
  const id = `${t.txHash.toLowerCase()}:${t.logIndex}`;
  if (db.payments[id]) return db.payments[id];

  const memoId = t.memoId?.toLowerCase() as Hex | undefined;
  const invoice = memoId
    ? Object.values(db.invoices).find((i) => i.merchant === to && i.memoId.toLowerCase() === memoId)
    : undefined;
  const { text, fields } = parseMemoText(t.memoData);
  const intent = fields.pay === "part" ? "part" : fields.pay === "full" ? "full" : null;

  const base = {
    amount: str(t.amount),
    from: t.from.toLowerCase() as Hex,
    timestamp: t.timestamp,
  };
  const hold = inboundHold(m.limits, base, merchantPayments(db, to));

  const p: Payment = {
    id,
    merchant: to,
    source: t.source,
    txHash: t.txHash.toLowerCase() as Hex,
    logIndex: t.logIndex,
    blockNumber: t.blockNumber.toString(),
    timestamp: t.timestamp,
    from: base.from,
    to,
    amount: base.amount,
    memoId: memoId ?? null,
    memoText: text,
    intent,
    invoiceId: invoice && !invoice.voided ? invoice.id : null,
    matchMethod: invoice && !invoice.voided ? "memo" : null,
    hold,
    recordedAt: now.toISOString(),
  };
  db.payments[id] = p;
  return p;
}

function getPayment(db: Db, merchant: Hex, paymentId: string): Payment {
  const p = db.payments[paymentId];
  if (!p || p.merchant !== merchant) throw new LedgerError("Payment not found", 404);
  return p;
}

function getInvoice(db: Db, merchant: Hex, invoiceId: string): Invoice {
  const i = db.invoices[invoiceId];
  if (!i || i.merchant !== merchant) throw new LedgerError("Invoice not found", 404);
  return i;
}

/** Review inbox: confirm which invoice an untagged transfer belongs to. */
export function assignPayment(db: Db, merchant: Hex, paymentId: string, invoiceId: string | null) {
  const p = getPayment(db, merchant, paymentId);
  if (p.matchMethod === "memo") throw new LedgerError("This payment was matched by its onchain memo and can't be reassigned.");
  if (invoiceId) {
    const inv = getInvoice(db, merchant, invoiceId);
    if (inv.voided) throw new LedgerError("That invoice is void.");
  }
  p.invoiceId = invoiceId;
  p.matchMethod = invoiceId ? "manual" : null;
  return p;
}

/** Review inbox: accept a payment that was held by a limit, or send it back. */
export function resolveHold(db: Db, merchant: Hex, paymentId: string, action: "accept" | "return", now: Date) {
  const p = getPayment(db, merchant, paymentId);
  if (!p.hold || p.hold.resolution) throw new LedgerError("This payment isn't waiting for review.");
  if (action === "accept") {
    p.hold.resolution = "accepted";
    p.hold.resolvedAt = now.toISOString();
    return { payment: p, refund: null };
  }
  const refund = createRefund(db, merchant, paymentId, str(big(p.amount)), "returned_hold", now, true);
  p.hold.resolution = "returned";
  p.hold.resolvedAt = now.toISOString();
  return { payment: p, refund };
}

export function addResolution(
  db: Db,
  merchant: Hex,
  invoiceId: string,
  kind: "write_off" | "credit",
  paymentId: string | null,
  now: Date,
): Resolution {
  const inv = getInvoice(db, merchant, invoiceId);
  const st = invoiceState(db, inv, now);
  let amount: bigint;
  if (kind === "write_off") {
    if (!["partial", "underpaid"].includes(st.status)) throw new LedgerError("Only an unpaid balance can be written off.");
    amount = big(st.balance);
  } else {
    const c = st.payments.find((x) => x.id === paymentId);
    if (!c || big(c.surplus) === 0n) throw new LedgerError("That payment has nothing extra to keep as credit.");
    amount = openSurplus(db, inv, c.id, big(c.surplus));
    if (amount <= 0n) throw new LedgerError("That payment's extra amount is already handled.");
  }
  const r: Resolution = { id: rid("r_"), kind, paymentId, amount: str(amount), at: now.toISOString() };
  inv.resolutions.push(r);
  return r;
}

/** Surplus on a payment not yet covered by a credit, a sent refund, or a refund in progress. */
function openSurplus(db: Db, inv: Invoice, paymentId: string, surplus: bigint): bigint {
  const resolved = inv.resolutions.filter((r) => r.paymentId === paymentId).reduce((a, r) => a + big(r.amount), 0n);
  const pending = Object.values(db.refunds)
    .filter((f) => f.paymentId === paymentId && f.status !== "sent")
    .reduce((a, f) => a + big(f.amount), 0n);
  return surplus - resolved - pending;
}

/**
 * Prepare a refund. Clearmark never holds funds: the merchant sends the refund from their own
 * wallet, and we record it only after verifying the transfer onchain (markRefundSent).
 */
export function createRefund(
  db: Db,
  merchant: Hex,
  paymentId: string,
  amountUnits: string | null,
  reason: Refund["reason"],
  now: Date,
  skipSurplusCheck = false,
): Refund {
  const m = getMerchant(db, merchant);
  const p = getPayment(db, merchant, paymentId);
  let amount: bigint;
  if (skipSurplusCheck) {
    amount = big(amountUnits ?? p.amount);
  } else {
    if (!p.invoiceId) throw new LedgerError("Match this payment to an invoice first, or return it from the review inbox.");
    const inv = getInvoice(db, merchant, p.invoiceId);
    const c = invoiceState(db, inv, now).payments.find((x) => x.id === p.id);
    const open = c ? openSurplus(db, inv, p.id, big(c.surplus)) : 0n;
    if (open <= 0n) throw new LedgerError("Nothing on this payment needs refunding.");
    amount = amountUnits ? big(amountUnits) : open;
    if (amount > open) throw new LedgerError(`You can refund at most ${fmt(open)} USDC on this payment.`);
    reason = c!.cls === "duplicate" ? "duplicate" : "overpayment";
  }
  if (amount <= 0n) throw new LedgerError("The refund must be more than zero.");
  const id = rid("f_");
  const refund: Refund = {
    id,
    merchant,
    paymentId,
    invoiceId: p.invoiceId,
    to: p.from,
    amount: str(amount),
    reason,
    status: refundNeedsApproval(m.limits, amount) ? "pending_approval" : "ready",
    memoId: refundMemoId(id),
    approvedAt: null,
    txHash: null,
    blockNumber: null,
    sentAt: null,
    createdAt: now.toISOString(),
    source: p.source,
  };
  db.refunds[id] = refund;
  return refund;
}

export function approveRefund(db: Db, merchant: Hex, refundId: string, now: Date): Refund {
  const r = db.refunds[refundId];
  if (!r || r.merchant !== merchant) throw new LedgerError("Refund not found", 404);
  if (r.status !== "pending_approval") throw new LedgerError("This refund doesn't need approval.");
  r.status = "ready";
  r.approvedAt = now.toISOString();
  return r;
}

export function cancelRefund(db: Db, merchant: Hex, refundId: string) {
  const r = db.refunds[refundId];
  if (!r || r.merchant !== merchant) throw new LedgerError("Refund not found", 404);
  if (r.status === "sent") throw new LedgerError("This refund was already sent.");
  delete db.refunds[refundId];
  const p = db.payments[r.paymentId];
  if (r.reason === "returned_hold" && p?.hold) {
    p.hold.resolution = null;
    delete p.hold.resolvedAt;
  }
}

/** Record a refund once its transfer is verified (or simulated in demo mode). */
export function markRefundSent(
  db: Db,
  merchant: Hex,
  refundId: string,
  tx: { txHash: Hex; blockNumber: bigint; timestamp: string; from: Hex; to: Hex; amount: bigint; memoId: Hex | null },
) {
  const r = db.refunds[refundId];
  if (!r || r.merchant !== merchant) throw new LedgerError("Refund not found", 404);
  if (r.status === "sent") return r;
  if (r.status !== "ready") throw new LedgerError("This refund still needs approval.");
  if (tx.from.toLowerCase() !== merchant) throw new LedgerError("That transaction wasn't sent from your wallet.");
  if (tx.to.toLowerCase() !== r.to) throw new LedgerError("That transaction didn't go to the original payer.");
  if (tx.amount !== big(r.amount)) throw new LedgerError(`That transaction sent ${fmt(tx.amount)} USDC, not ${fmt(r.amount)}.`);
  if (tx.memoId && tx.memoId.toLowerCase() !== r.memoId.toLowerCase()) throw new LedgerError("That transaction carries a different memo.");
  r.status = "sent";
  r.txHash = tx.txHash.toLowerCase() as Hex;
  r.blockNumber = tx.blockNumber.toString();
  r.sentAt = tx.timestamp;
  if (r.invoiceId && r.reason !== "returned_hold") {
    db.invoices[r.invoiceId].resolutions.push({
      id: rid("r_"),
      kind: "refund",
      paymentId: r.paymentId,
      amount: r.amount,
      refundId: r.id,
      at: tx.timestamp,
    });
  }
  return r;
}

export function updateLimits(db: Db, merchant: Hex, input: Record<keyof Limits, string | null>): Limits {
  const m = getMerchant(db, merchant);
  const next = {} as Limits;
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = input[k];
    if (v === null || v === undefined || String(v).trim() === "") next[k] = null;
    else {
      try {
        next[k] = str(toUnits(v));
      } catch {
        throw new LedgerError(`Invalid amount for ${k}`);
      }
    }
  }
  m.limits = next;
  return next;
}

export function setMerchantName(db: Db, merchant: Hex, name: string) {
  const m = getMerchant(db, merchant);
  const n = name.trim().slice(0, 60);
  if (!n) throw new LedgerError("Add a business name.");
  m.name = n;
  return m;
}

export function voidInvoice(db: Db, merchant: Hex, invoiceId: string, now: Date) {
  const inv = getInvoice(db, merchant, invoiceId);
  const st = invoiceState(db, inv, now);
  if (big(st.received) > 0n) throw new LedgerError("This invoice already received money, so it can't be voided.");
  inv.voided = true;
  return inv;
}
