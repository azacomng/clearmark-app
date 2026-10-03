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
  resolutions: Resolution[];
  /** Optional early-pay discount and late fee. Missing on invoices made before Smart Terms. */
  terms?: Terms | null;
}

export type HoldReason = "over_max" | "daily_cap" | "customer_cap";

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
}

export interface Db {
  version: 1;
  merchants: Record<string, Merchant>;
  invoices: Record<string, Invoice>;
  payments: Record<string, Payment>;
  refunds: Record<string, Refund>;
  nonces: Record<string, { address: Hex; expires: number }>;
  secret?: string;
}
