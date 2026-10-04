import type { Token } from "./arc";
import type { Units } from "./money";

export type Hex = `0x${string}`;

export interface Limits {
  /** Checkout refuses larger amounts; any larger inbound transfer is held for review. */
  maxPerPayment: Units | null;
  /** Total inbound per UTC day. Links pause once reached; inbound above it is held. */
  dailyCap: Units | null;
  /** Inbound per payer address per calendar month. */
  perCustomerMonthlyCap: Units | null;
  /** Refunds above this need an explicit second approval (signed) before they can be sent. */
  refundApprovalAbove: Units | null;
}

export interface Merchant {
  address: Hex; // lowercase
  name: string;
  createdAt: string;
  /** First block to scan for inbound transfers. */
  startBlock: string | null;
  lastSyncedBlock: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  nextInvoiceNo: number;
  limits: Limits;
  /** Show amounts on public share cards (link previews). Defaults to true. */
  publicAmounts?: boolean;
}

/** Who voided an invoice or a payment, when and why. Voided items stay in history, crossed out. */
export interface VoidRecord {
  reason: string;
  by: Hex;
  at: string;
}

export interface Resolution {
  id: string;
  kind: "write_off" | "credit" | "refund";
  /** The payment the resolution is about (duplicate or excess), if any. */
  paymentId: string | null;
  amount: Units;
  refundId?: string;
  note?: string;
  at: string;
}

/** Smart Terms. Basis points: 200 = 2%. Zero means the term is off. */
export interface Terms {
  earlyBps: number;
  earlyDays: number;
  lateBps: number;
}

/** Invoice currency. EUR invoices are paid in EURC 1:1, or in USDC at a quoted rate. */
export type Currency = "USDC" | "EUR";

/** Payday Splits: a collaborator's share of an invoice, paid out after the invoice is paid. */
export interface Split {
  label: string;
  address: Hex;
  bps: number;
}

export interface Invoice {
  id: string; // public slug used in links
  merchant: Hex;
  number: string; // INV-10001
  title: string;
  customerName: string;
  customerEmail: string | null;
  amount: Units;
  tolerance: Units;
  dueDate: string; // YYYY-MM-DD
  allowSplit: boolean;
  memoId: Hex;
  createdAt: string;
  voided: boolean;
  /** Missing on invoices voided before reasons were recorded. */
  voidInfo?: VoidRecord | null;
  resolutions: Resolution[];
  /** Optional early-pay discount and late fee. Missing on invoices made before Smart Terms. */
  terms?: Terms | null;
  /** Missing on older invoices, which are USDC. */
  currency?: Currency;
  splits?: Split[];
  /** USDC received on a EUR invoice that the merchant swapped to EURC with Swap Kit. */
  conversions?: { txHash: Hex; amountIn: Units; at: string }[];
}

export type HoldReason = "over_max" | "daily_cap" | "customer_cap" | "fx_missing";

export interface Hold {
  reason: HoldReason;
  detail: string;
  resolution: null | "accepted" | "returned";
  resolvedAt?: string;
}

export interface Payment {
  id: string;
  merchant: Hex;
  source: "chain" | "demo";
  txHash: Hex;
  logIndex: number;
  blockNumber: string;
  timestamp: string;
  from: Hex;
  to: Hex;
  amount: Units;
  memoId: Hex | null;
  memoText: string | null;
  /** "part" when the payer chose to pay part of a split invoice at checkout. */
  intent: "full" | "part" | null;
  invoiceId: string | null;
  matchMethod: "memo" | "manual" | null;
  hold: Hold | null;
  recordedAt: string;
  /** Wallet-to-final time measured at Clearmark checkout, in ms. Null when paid another way. */
  settleMs?: number | null;
  /** Missing on older payments, which are USDC. */
  token?: Token;
  /**
   * Conversion into the invoice currency when the token differs from it (USDC paid on a EUR
   * invoice). rate = invoice units per 1 token unit, scaled by 1e6.
   */
  fx?: { rate: Units; quoteId: string | null; source: string } | null;
  /** Source chain for a payment bridged to Arc before it was paid (e.g. "Base Sepolia"). */
  via?: string | null;
  /** Dismissed by the merchant: it no longer counts toward any invoice. The money itself isn't moved. */
  voided?: VoidRecord | null;
}

export type RefundStatus = "pending_approval" | "ready" | "sent";

export interface Refund {
  id: string;
  merchant: Hex;
  paymentId: string;
  invoiceId: string | null;
  to: Hex;
  amount: Units;
  reason: "duplicate" | "overpayment" | "returned_hold" | "manual";
  status: RefundStatus;
  memoId: Hex;
  approvedAt: string | null;
  txHash: Hex | null;
  blockNumber: string | null;
  sentAt: string | null;
  createdAt: string;
  source: "chain" | "demo";
  /** Token the refund is sent in (the original payment's). Missing = USDC. */
  token?: Token;
  /** What the refund resolves on the invoice, in invoice units (differs from amount only with FX). */
  invoiceUnits?: Units;
}

export interface PayoutLine {
  label: string;
  address: Hex;
  bps: number;
  amount: Units;
}

export interface Payout {
  id: string;
  merchant: Hex;
  invoiceId: string;
  token: Token;
  /** What the shares are computed on: the settled invoice amount. */
  base: Units;
  lines: PayoutLine[];
  status: "ready" | "sent";
  txHash: Hex | null;
  blockNumber: string | null;
  sentAt: string | null;
  createdAt: string;
  source: "chain" | "demo";
}

/** A USDC price for a EUR invoice, fixed for a short window so the payer knows what to send. */
export interface Quote {
  id: string;
  invoiceId: string;
  /** EUR units per 1 USDC, scaled by 1e6. */
  rate: Units;
  usdc: Units;
  eur: Units;
  source: string;
  createdAt: string;
  expiresAt: string;
}

export interface Db {
  version: 1;
  merchants: Record<string, Merchant>;
  invoices: Record<string, Invoice>;
  payments: Record<string, Payment>;
  refunds: Record<string, Refund>;
  nonces: Record<string, { address: Hex; expires: number }>;
  payouts?: Record<string, Payout>;
  quotes?: Record<string, Quote>;
  secret?: string;
}
