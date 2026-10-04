// Ledger operations on the in-memory Db. No I/O here: the service layer loads the Db,
// calls these, and saves. That keeps every money rule unit-testable.

import { isAddress } from "viem";
import { invoiceMemoId, parseMemoText, refundMemoId, type Token } from "./arc";
import { currencyOf, nativeToken, needsFx, paymentValue, toInvoiceUnits, toTokenUnits, tokenOf } from "./fx";
import { reconcile, type InvoiceState } from "./engine";
import { DEFAULT_LIMITS, inboundHold, refundNeedsApproval } from "./limits";
import { big, fmt, str, toUnits } from "./money";
import { parseTerms, type TermsInput } from "./terms";
import type { Currency, Db, Hex, Invoice, Limits, Merchant, Payment, Payout, Quote, Refund, Resolution, Split, Terms, VoidRecord } from "./types";

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
  terms?: TermsInput | null;
  currency?: Currency;
  splits?: { label?: string; address?: string; pct?: string | number }[] | null;
}

const MAX_SPLITS = 8;

/** Validate Payday Splits. Percentages of the settled invoice; the merchant keeps the rest. */
export function parseSplits(input: NewInvoice["splits"], merchant: Hex): Split[] {
  if (!input || input.length === 0) return [];
  if (input.length > MAX_SPLITS) throw new LedgerError(`Up to ${MAX_SPLITS} collaborators per invoice.`);
  const out: Split[] = [];
  const seen = new Set<string>();
  for (const [i, r] of input.entries()) {
    const label = (r.label ?? "").trim().slice(0, 40) || `Collaborator ${i + 1}`;
    const address = String(r.address ?? "").trim();
    if (!isAddress(address)) throw new LedgerError(`${label}: that isn't a valid wallet address.`);
    const a = address.toLowerCase() as Hex;
    if (a === merchant) throw new LedgerError(`${label}: that's your own wallet. Your share is whatever is left.`);
    if (seen.has(a)) throw new LedgerError(`${label}: that wallet is already in the list.`);
    seen.add(a);
    const pct = Number(String(r.pct ?? "").trim());
    if (!Number.isFinite(pct) || pct <= 0) throw new LedgerError(`${label}: enter a share above 0%.`);
    const bps = Math.round(pct * 100);
    if (bps < 1 || bps > 10_000) throw new LedgerError(`${label}: the share must be between 0.01% and 100%.`);
    out.push({ label, address: a, bps });
  }
  const total = out.reduce((t, x) => t + x.bps, 0);
  if (total > 10_000) throw new LedgerError(`Shares add up to ${total / 100}%, more than the invoice.`);
  return out;
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
  const currency: Currency = input.currency === "EUR" ? "EUR" : "USDC";
  const splits = parseSplits(input.splits, m.address);
  if (m.limits.maxPerPayment && amount > big(m.limits.maxPerPayment) && !allowSplit) {
    throw new LedgerError(
      `This is above your ${fmt(m.limits.maxPerPayment)} USDC max per payment. Turn on split payments or raise the limit.`,
    );
  }
  const createdAt = now.toISOString();
  let terms: Terms | null;
  try {
    terms = parseTerms(input.terms, createdAt, input.dueDate);
  } catch (e) {
    throw new LedgerError((e as Error).message);
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
    createdAt,
    voided: false,
    resolutions: [],
    terms,
    currency,
    splits,
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
  token?: Token;
}

/** Quotes stay usable a little past expiry, for a payment signed just before it. */
const QUOTE_GRACE_MS = 5 * 60_000;

/**
 * Record one inbound USDC or EURC transfer to a merchant. Idempotent on (txHash, logIndex).
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
  const token: Token = t.token ?? "USDC";
  const matched = invoice && !invoice.voided ? invoice : null;
  const via = fields.via ? fields.via.replace(/_/g, " ").slice(0, 40) : null;

  // A payment in a different token than the invoice currency needs a rate. Checkout fixes one
  // in a quote and writes its id into the memo; without a usable quote the payment is held.
  let fx: Payment["fx"] = null;
  let fxHold = false;
  if (matched && needsFx(currencyOf(matched), token)) {
    const q = fields.q ? db.quotes?.[fields.q] : undefined;
    if (q && q.invoiceId === matched.id && Date.parse(t.timestamp) <= Date.parse(q.expiresAt) + QUOTE_GRACE_MS) {
      fx = { rate: q.rate, quoteId: q.id, source: q.source };
    } else {
      fxHold = true;
    }
  }

  const base = {
    amount: str(t.amount),
    from: t.from.toLowerCase() as Hex,
    timestamp: t.timestamp,
  };
  // Limits are set in USDC; EURC amounts are compared as-is (close enough for caps).
  const hold = fxHold
    ? { reason: "fx_missing" as const, detail: `This ${token} payment has no valid rate quote, so confirm the rate before it counts toward the ${currencyOf(matched!)} invoice.`, resolution: null }
    : inboundHold(m.limits, base, merchantPayments(db, to));

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
    invoiceId: matched ? matched.id : null,
    matchMethod: matched ? "memo" : null,
    hold,
    recordedAt: now.toISOString(),
    token,
    fx,
    via,
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
  if (p.voided) throw new LedgerError("This payment was voided.");
  if (p.matchMethod === "memo") throw new LedgerError("This payment was matched by its onchain memo and can't be reassigned.");
  if (invoiceId) {
    const inv = getInvoice(db, merchant, invoiceId);
    if (inv.voided) throw new LedgerError("That invoice is void.");
  }
  p.invoiceId = invoiceId;
  p.matchMethod = invoiceId ? "manual" : null;
  // Matching a payment to an invoice in another currency needs a rate before it counts.
  if (invoiceId && needsFx(currencyOf(db.invoices[invoiceId]), tokenOf(p)) && !p.fx && !p.hold) {
    p.hold = { reason: "fx_missing", detail: `This ${tokenOf(p)} payment needs a rate before it counts toward a ${currencyOf(db.invoices[invoiceId])} invoice.`, resolution: null };
  }
  return p;
}

/** Review inbox: accept a payment that was held by a limit, or send it back. */
export function resolveHold(
  db: Db,
  merchant: Hex,
  paymentId: string,
  action: "accept" | "return",
  now: Date,
  rate?: { rate: bigint; source: string } | null,
) {
  const p = getPayment(db, merchant, paymentId);
  if (p.voided) throw new LedgerError("This payment was voided.");
  if (!p.hold || p.hold.resolution) throw new LedgerError("This payment isn't waiting for review.");
  if (action === "accept") {
    if (p.hold.reason === "fx_missing") {
      if (!rate) throw new LedgerError("The exchange rate is unavailable right now, so this payment can't be accepted yet. Try again shortly.");
      p.fx = { rate: rate.rate.toString(), quoteId: null, source: rate.source };
    }
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
    .reduce((a, f) => a + big(f.invoiceUnits ?? f.amount), 0n);
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
  if (p.voided) throw new LedgerError("This payment was voided, so there's nothing to refund.");
  let amount: bigint;
  let invoiceUnits: bigint | null = null;
  if (skipSurplusCheck) {
    amount = big(amountUnits ?? p.amount);
  } else {
    if (!p.invoiceId) throw new LedgerError("Match this payment to an invoice first, or return it from the review inbox.");
    const inv = getInvoice(db, merchant, p.invoiceId);
    const c = invoiceState(db, inv, now).payments.find((x) => x.id === p.id);
    const open = c ? openSurplus(db, inv, p.id, big(c.surplus)) : 0n;
    if (open <= 0n) throw new LedgerError("Nothing on this payment needs refunding.");
    // `open` is in invoice units. Refunds go back in the token the payer sent.
    invoiceUnits = amountUnits ? big(amountUnits) : open;
    if (invoiceUnits > open) throw new LedgerError(`You can refund at most ${fmt(open)} on this payment.`);
    amount = p.fx && needsFx(currencyOf(inv), tokenOf(p)) ? toTokenUnits(invoiceUnits, big(p.fx.rate)) : invoiceUnits;
    if (amount > big(p.amount)) amount = big(p.amount);
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
    token: tokenOf(p),
    ...(invoiceUnits !== null ? { invoiceUnits: str(invoiceUnits) } : {}),
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
  tx: { txHash: Hex; blockNumber: bigint; timestamp: string; from: Hex; to: Hex; amount: bigint; memoId: Hex | null; token?: Token },
) {
  const r = db.refunds[refundId];
  if (!r || r.merchant !== merchant) throw new LedgerError("Refund not found", 404);
  if (r.status === "sent") return r;
  if (r.status !== "ready") throw new LedgerError("This refund still needs approval.");
  if (tx.from.toLowerCase() !== merchant) throw new LedgerError("That transaction wasn't sent from your wallet.");
  if (tx.to.toLowerCase() !== r.to) throw new LedgerError("That transaction didn't go to the original payer.");
  if ((tx.token ?? "USDC") !== (r.token ?? "USDC")) throw new LedgerError(`That transaction sent ${tx.token ?? "USDC"}, but this refund is in ${r.token ?? "USDC"}.`);
  if (tx.amount !== big(r.amount)) throw new LedgerError(`That transaction sent ${fmt(tx.amount)} ${r.token ?? "USDC"}, not ${fmt(r.amount)}.`);
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
      amount: r.invoiceUnits ?? r.amount,
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

/**
 * Record how long a checkout payment took from the wallet to final, as measured by the payer's
 * browser. Cosmetic (it feeds the "Settled in" stamp), so it's only taken once, for a payment
 * that was just recorded, and only within a sane range.
 */
export function recordSettleTime(db: Db, paymentIds: string[], ms: unknown, now: Date) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0 || n > 120_000) return;
  for (const id of paymentIds) {
    const p = db.payments[id];
    if (!p || p.settleMs != null) continue;
    if (now.getTime() - Date.parse(p.recordedAt) > 10 * 60_000) continue;
    p.settleMs = Math.round(n);
  }
}

export function setPublicAmounts(db: Db, merchant: Hex, show: boolean) {
  const m = getMerchant(db, merchant);
  m.publicAmounts = !!show;
  return m;
}

export function setMerchantName(db: Db, merchant: Hex, name: string) {
  const m = getMerchant(db, merchant);
  const n = name.trim().slice(0, 60);
  if (!n) throw new LedgerError("Add a business name.");
  m.name = n;
  return m;
}

function voidRecord(merchant: Hex, reason: unknown, now: Date): VoidRecord {
  const r = String(reason ?? "").trim().replace(/\s+/g, " ");
  if (r.length < 3) throw new LedgerError("Add a short reason, so the history shows why.");
  if (r.length > 200) throw new LedgerError("Keep the reason under 200 characters.");
  return { reason: r, by: merchant, at: now.toISOString() };
}

/** Void an invoice that hasn't received money. It stays in history, crossed out, with the reason. */
export function voidInvoice(db: Db, merchant: Hex, invoiceId: string, reason: unknown, now: Date) {
  const inv = getInvoice(db, merchant, invoiceId);
  if (inv.voided) throw new LedgerError("This invoice is already void.");
  const st = invoiceState(db, inv, now);
  if (big(st.received) > 0n) throw new LedgerError("This invoice already received money, so it can't be voided.");
  inv.voidInfo = voidRecord(merchant, reason, now);
  inv.voided = true;
  return inv;
}

/**
 * Void (dismiss) a payment: it stops counting toward its invoice and leaves the review inbox, but stays
 * in history, crossed out. The money isn't moved; a payment that has been refunded or credited can't be
 * voided, and neither can one whose removal would undo a refund or credit on another payment.
 */
export function voidPayment(db: Db, merchant: Hex, paymentId: string, reason: unknown, now: Date): Payment {
  const p = getPayment(db, merchant, paymentId);
  if (p.voided) throw new LedgerError("This payment is already void.");
  const record = voidRecord(merchant, reason, now);
  if (Object.values(db.refunds).some((f) => f.paymentId === p.id)) {
    throw new LedgerError("This payment has a refund, so it can't be voided. Cancel the refund first if it hasn't been sent.");
  }
  const inv = p.invoiceId ? db.invoices[p.invoiceId] : undefined;
  if (inv?.resolutions.some((r) => r.paymentId === p.id)) throw new LedgerError("Part of this payment is kept as customer credit, so it can't be voided.");
  if (inv) {
    // Removing a payment can re-classify the others; refunds and credits already on them must still fit.
    p.voided = record;
    if (overHandled(db, inv, now)) {
      p.voided = null;
      throw new LedgerError("Voiding this would undo a refund or credit on another payment of this invoice.");
    }
  }
  p.voided = record;
  return p;
}

/**
 * Delete a simulated (demo) payment, with its simulated refunds and any credit kept from it, as if it
 * never happened. Real payments can't be deleted: they happened onchain, so they can only be voided.
 */
export function deleteDemoPayment(db: Db, merchant: Hex, paymentId: string, now: Date) {
  const p = getPayment(db, merchant, paymentId);
  if (p.source !== "demo") throw new LedgerError("Only simulated payments can be deleted. Void a real payment instead.");
  const inv = p.invoiceId ? db.invoices[p.invoiceId] : undefined;
  if (inv && invoicePayouts(db, inv.id).length) throw new LedgerError("This invoice has a payout, so its payments can't be deleted.");
  const own = Object.values(db.refunds).filter((f) => f.paymentId === p.id);
  const ownRes = inv ? inv.resolutions.filter((r) => r.paymentId === p.id) : [];
  // Removing a payment can re-classify the others; refunds and credits on them must still fit.
  const before = { payment: p, refunds: own, resolutions: inv?.resolutions };
  delete db.payments[p.id];
  for (const f of own) delete db.refunds[f.id];
  if (inv) inv.resolutions = inv.resolutions.filter((r) => !ownRes.includes(r));
  if (inv && overHandled(db, inv, now)) {
    db.payments[p.id] = before.payment;
    for (const f of before.refunds) db.refunds[f.id] = f;
    inv.resolutions = before.resolutions!;
    throw new LedgerError("Deleting this would undo a refund or credit on another payment of this invoice.");
  }
  return { deleted: p.id, invoiceId: p.invoiceId };
}

/** True when some payment on the invoice has more refunded or credited than it has extra. */
function overHandled(db: Db, inv: Invoice, now: Date): boolean {
  return invoiceState(db, inv, now).payments.some((c) => {
    const handled =
      inv.resolutions.filter((r) => r.paymentId === c.id).reduce((a, r) => a + big(r.amount), 0n) +
      Object.values(db.refunds)
        .filter((f) => f.paymentId === c.id && f.status !== "sent")
        .reduce((a, f) => a + big(f.invoiceUnits ?? f.amount), 0n);
    return handled > big(c.surplus);
  });
}

// ---------- Quotes (EUR invoices paid in USDC) ----------

export const QUOTE_TTL_MS = 15 * 60_000;

/** Fix a USDC price for the invoice's current EUR balance. rate = EUR units per 1 USDC (x1e6). */
export function createQuote(db: Db, invoiceId: string, eurDue: bigint, rate: bigint, source: string, now: Date): Quote {
  const inv = db.invoices[invoiceId];
  if (!inv || inv.voided) throw new LedgerError("This payment link doesn't exist.", 404);
  if (currencyOf(inv) !== "EUR") throw new LedgerError("This invoice is in USDC, so it needs no quote.");
  if (rate <= 0n) throw new LedgerError("The exchange rate is unavailable right now.");
  if (eurDue <= 0n) throw new LedgerError("Nothing is due on this invoice.");
  db.quotes ??= {};
  // Drop expired quotes so the store doesn't grow forever.
  for (const [k, q] of Object.entries(db.quotes)) {
    if (Date.parse(q.expiresAt) + QUOTE_GRACE_MS + 86_400_000 < now.getTime()) delete db.quotes[k];
  }
  const q: Quote = {
    id: rid("q", 6),
    invoiceId,
    rate: str(rate),
    usdc: str(toTokenUnits(eurDue, rate)),
    eur: str(eurDue),
    source,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
  };
  db.quotes[q.id] = q;
  return q;
}

// ---------- Payday Splits ----------

export function invoicePayouts(db: Db, invoiceId: string): Payout[] {
  return Object.values(db.payouts ?? {}).filter((p) => p.invoiceId === invoiceId);
}

/** Shares are computed on what the invoice settled for (its price, never more than was counted). */
export function payoutPlan(db: Db, inv: Invoice, now = new Date()) {
  const st = invoiceState(db, inv, now);
  const settled = big(st.counted) < big(st.price) ? big(st.counted) : big(st.price);
  const lines = (inv.splits ?? []).map((s) => ({ ...s, amount: str((settled * BigInt(s.bps)) / 10_000n) }));
  return { status: st.status, base: settled, lines, token: nativeToken(currencyOf(inv)) };
}

/** Prepare the collaborator payout for a paid invoice. One per invoice. */
export function createPayout(db: Db, merchant: Hex, invoiceId: string, now: Date): Payout {
  const inv = getInvoice(db, merchant, invoiceId);
  if (!inv.splits?.length) throw new LedgerError("This invoice has no collaborators to pay.");
  const existing = invoicePayouts(db, invoiceId)[0];
  if (existing) return existing;
  const plan = payoutPlan(db, inv, now);
  // Overpaid and duplicate invoices are covered too; the extra is the merchant's to refund, not to split.
  if (!["paid", "overpaid", "duplicate"].includes(plan.status)) throw new LedgerError("Collaborators are paid once the invoice is fully paid.");
  if (plan.lines.some((l) => big(l.amount) <= 0n)) throw new LedgerError("A share works out to zero, so there's nothing to send.");
  const has = Object.values(db.payments).some((p) => p.invoiceId === inv.id && p.source === "chain");
  const payout: Payout = {
    id: rid("s_"),
    merchant,
    invoiceId,
    token: plan.token,
    base: str(plan.base),
    lines: plan.lines,
    status: "ready",
    txHash: null,
    blockNumber: null,
    sentAt: null,
    createdAt: now.toISOString(),
    source: has ? "chain" : "demo",
  };
  db.payouts ??= {};
  db.payouts[payout.id] = payout;
  return payout;
}

export function cancelPayout(db: Db, merchant: Hex, payoutId: string) {
  const p = db.payouts?.[payoutId];
  if (!p || p.merchant !== merchant) throw new LedgerError("Payout not found", 404);
  if (p.status === "sent") throw new LedgerError("This payout was already sent.");
  delete db.payouts![payoutId];
}

/**
 * Record a payout once its batch transaction is verified: every collaborator must have received
 * exactly their share, in the payout token, from the merchant's own wallet.
 */
export function markPayoutSent(
  db: Db,
  merchant: Hex,
  payoutId: string,
  tx: { txHash: Hex; blockNumber: bigint; timestamp: string; transfers: { from: Hex; to: Hex; amount: bigint; token: Token }[] },
): Payout {
  const p = db.payouts?.[payoutId];
  if (!p || p.merchant !== merchant) throw new LedgerError("Payout not found", 404);
  if (p.status === "sent") return p;
  const pool = tx.transfers.filter((t) => t.from.toLowerCase() === merchant && t.token === p.token);
  for (const l of p.lines) {
    const i = pool.findIndex((t) => t.to.toLowerCase() === l.address && t.amount === big(l.amount));
    if (i < 0) throw new LedgerError(`That transaction doesn't pay ${l.label} exactly ${fmt(l.amount)} ${p.token} from your wallet.`);
    pool.splice(i, 1);
  }
  p.status = "sent";
  p.txHash = tx.txHash.toLowerCase() as Hex;
  p.blockNumber = tx.blockNumber.toString();
  p.sentAt = tx.timestamp;
  return p;
}

// ---------- Swap Kit conversions (USDC received on EUR invoices) ----------

export function recordConversion(db: Db, merchant: Hex, invoiceId: string, txHash: Hex, amountIn: bigint, now: Date) {
  const inv = getInvoice(db, merchant, invoiceId);
  if (currencyOf(inv) !== "EUR") throw new LedgerError("Only EUR invoices convert to EURC.");
  inv.conversions ??= [];
  if (!inv.conversions.some((c) => c.txHash === txHash.toLowerCase())) {
    inv.conversions.push({ txHash: txHash.toLowerCase() as Hex, amountIn: str(amountIn), at: now.toISOString() });
  }
  return inv;
}

/** USDC received on a EUR invoice that hasn't been converted to EURC yet. */
export function unconvertedUsdc(db: Db, inv: Invoice): bigint {
  if (currencyOf(inv) !== "EUR") return 0n;
  const usdc = Object.values(db.payments)
    .filter((p) => p.invoiceId === inv.id && tokenOf(p) === "USDC" && (!p.hold || p.hold.resolution === "accepted"))
    .reduce((a, p) => a + big(p.amount), 0n);
  const refunded = Object.values(db.refunds)
    .filter((r) => r.invoiceId === inv.id && r.status === "sent" && (r.token ?? "USDC") === "USDC")
    .reduce((a, r) => a + big(r.amount), 0n);
  const done = (inv.conversions ?? []).reduce((a, c) => a + big(c.amountIn), 0n);
  const left = usdc - refunded - done;
  return left > 0n ? left : 0n;
}

export { paymentValue, toInvoiceUnits };
