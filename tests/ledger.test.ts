import { describe, expect, it } from "vitest";
import { encodeEventTopics, encodeAbiParameters, keccak256, type Log } from "viem";
import {
  extractTransfers,
  invoiceMemoId,
  memoAbi,
  memoText,
  MEMO_ADDRESS,
  transferCalldata,
  USDC_ADDRESS,
  erc20Abi,
} from "@/lib/arc";
import {
  addResolution,
  approveRefund,
  assignPayment,
  createInvoice,
  createRefund,
  ensureMerchant,
  invoiceState,
  markRefundSent,
  recordTransfer,
  resolveHold,
  updateLimits,
} from "@/lib/ledger";
import { checkoutCheck } from "@/lib/limits";
import { suggestMatches } from "@/lib/matching";
import { toUnits } from "@/lib/money";
import type { Db, Hex } from "@/lib/types";

const M = "0x4f2c000000000000000000000000000000091ae0" as Hex;
const PAYER = "0x9a1d00000000000000000000000000000000c07b" as Hex;
const now = new Date("2026-09-28T12:00:00Z");
const fresh = (): Db => ({ version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });

let tx = 0;
const transfer = (amount: string, memoId: Hex | null, extra: Partial<Parameters<typeof recordTransfer>[1]> = {}) => ({
  source: "demo" as const,
  txHash: `0x${(++tx).toString(16).padStart(64, "0")}` as Hex,
  logIndex: 0,
  blockNumber: BigInt(tx),
  timestamp: now.toISOString(),
  from: PAYER,
  to: M,
  amount: toUnits(amount),
  memoId,
  memoData: memoText({ pay: "full" }),
  ...extra,
});

function setup() {
  const db = fresh();
  ensureMerchant(db, M, now, 1n);
  const inv = createInvoice(db, M, { title: "Website design", customerName: "Northwind", amount: "250", tolerance: "0.5", dueDate: "2026-09-30" }, now);
  return { db, inv };
}

describe("ledger", () => {
  it("matches a memo-tagged transfer to its invoice and is idempotent", () => {
    const { db, inv } = setup();
    const t = transfer("250", inv.memoId);
    const p = recordTransfer(db, t, now)!;
    expect(p.invoiceId).toBe(inv.id);
    expect(p.matchMethod).toBe("memo");
    recordTransfer(db, t, now);
    expect(Object.keys(db.payments)).toHaveLength(1);
    expect(invoiceState(db, inv, now).label).toBe("PAID");
  });

  it("ignores transfers to addresses that aren't merchants", () => {
    const { db } = setup();
    expect(recordTransfer(db, transfer("5", null, { to: PAYER }), now)).toBeNull();
  });

  it("leaves untagged transfers unmatched and suggests the right invoice", () => {
    const { db, inv } = setup();
    const p = recordTransfer(db, transfer("250", null), now)!;
    expect(p.invoiceId).toBeNull();
    const s = suggestMatches(p, Object.values(db.invoices), Object.values(db.payments), now);
    expect(s[0].invoiceId).toBe(inv.id);
    assignPayment(db, M, p.id, inv.id);
    expect(invoiceState(db, inv, now).status).toBe("paid");
  });

  it("does not match a memo that belongs to another merchant's invoice", () => {
    const { db, inv } = setup();
    const other = "0x1111111111111111111111111111111111111111" as Hex;
    ensureMerchant(db, other, now, 1n);
    const p = recordTransfer(db, transfer("250", inv.memoId, { to: other }), now)!;
    expect(p.invoiceId).toBeNull();
  });

  it("holds a payment over the max per payment until reviewed", () => {
    const { db, inv } = setup();
    updateLimits(db, M, { maxPerPayment: "100", dailyCap: null, perCustomerMonthlyCap: null, refundApprovalAbove: "500" });
    const p = recordTransfer(db, transfer("250", inv.memoId), now)!;
    expect(p.hold?.reason).toBe("over_max");
    expect(invoiceState(db, inv, now).status).toBe("open");
    resolveHold(db, M, p.id, "accept", now);
    expect(invoiceState(db, inv, now).status).toBe("paid");
  });

  it("holds payments past the daily cap", () => {
    const { db, inv } = setup();
    updateLimits(db, M, { maxPerPayment: null, dailyCap: "300", perCustomerMonthlyCap: null, refundApprovalAbove: null });
    recordTransfer(db, transfer("250", inv.memoId), now);
    const p2 = recordTransfer(db, transfer("100", null), now)!;
    expect(p2.hold?.reason).toBe("daily_cap");
  });

  it("returning a held payment creates a refund to the sender", () => {
    const { db, inv } = setup();
    updateLimits(db, M, { maxPerPayment: "100", dailyCap: null, perCustomerMonthlyCap: null, refundApprovalAbove: null });
    const p = recordTransfer(db, transfer("250", inv.memoId), now)!;
    const { refund } = resolveHold(db, M, p.id, "return", now);
    expect(refund?.to).toBe(PAYER);
    expect(refund?.amount).toBe(toUnits("250").toString());
  });

  it("duplicate -> refund (with approval above threshold) -> PAID · REFUNDED", () => {
    const { db, inv } = setup();
    updateLimits(db, M, { maxPerPayment: null, dailyCap: null, perCustomerMonthlyCap: null, refundApprovalAbove: "100" });
    recordTransfer(db, transfer("250", inv.memoId), now);
    const dup = recordTransfer(db, transfer("250", inv.memoId), now)!;
    expect(invoiceState(db, inv, now).status).toBe("duplicate");
    const r = createRefund(db, M, dup.id, null, "manual", now);
    expect(r.reason).toBe("duplicate");
    expect(r.status).toBe("pending_approval");
    expect(() => createRefund(db, M, dup.id, null, "manual", now)).toThrow(/Nothing/);
    expect(() =>
      markRefundSent(db, M, r.id, { txHash: "0xaa", blockNumber: 9n, timestamp: now.toISOString(), from: M, to: PAYER, amount: toUnits("250"), memoId: r.memoId }),
    ).toThrow(/approval/);
    approveRefund(db, M, r.id, now);
    expect(() =>
      markRefundSent(db, M, r.id, { txHash: "0xaa", blockNumber: 9n, timestamp: now.toISOString(), from: M, to: PAYER, amount: toUnits("200"), memoId: r.memoId }),
    ).toThrow(/not 250/);
    markRefundSent(db, M, r.id, { txHash: "0xaa", blockNumber: 9n, timestamp: now.toISOString(), from: M, to: PAYER, amount: toUnits("250"), memoId: r.memoId });
    expect(invoiceState(db, inv, now).label).toBe("PAID · REFUNDED");
  });

  it("overpaid -> keep as credit -> PAID · CREDITED", () => {
    const { db, inv } = setup();
    const p = recordTransfer(db, transfer("300", inv.memoId), now)!;
    expect(invoiceState(db, inv, now).status).toBe("overpaid");
    addResolution(db, M, inv.id, "credit", p.id, now);
    expect(invoiceState(db, inv, now).label).toBe("PAID · CREDITED");
  });

  it("underpaid -> write off -> PAID · WRITTEN OFF", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("200", inv.memoId), now);
    addResolution(db, M, inv.id, "write_off", null, now);
    expect(invoiceState(db, inv, now).label).toBe("PAID · WRITTEN OFF");
  });

  it("refuses invoices above the per-payment max unless split is allowed", () => {
    const { db } = setup();
    expect(() => createInvoice(db, M, { title: "Big", customerName: "X", amount: "9000", dueDate: "2026-10-30" }, now)).toThrow(/max per payment/);
    expect(createInvoice(db, M, { title: "Big", customerName: "X", amount: "9000", dueDate: "2026-10-30", allowSplit: true }, now).allowSplit).toBe(true);
  });

  it("checkout caps the payable amount by the tightest limit", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("19900", null), now);
    const c = checkoutCheck(db.merchants[M].limits, toUnits("250"), Object.values(db.payments), now.toISOString());
    expect(c.ok).toBe(true); // 19,900 payment was held (over max), so it doesn't count toward the daily cap
    void inv;
  });
});

describe("extractTransfers", () => {
  it("links a Memo event to its USDC transfer by callDataHash", () => {
    const memoId = invoiceMemoId("abc");
    const amount = toUnits("250");
    const memoBytes = memoText({ pay: "full" });
    const transferLog = {
      address: USDC_ADDRESS,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER, to: M } }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
      logIndex: 3,
      blockNumber: 77n,
    } as unknown as Log;
    const memoLog = {
      address: MEMO_ADDRESS,
      topics: encodeEventTopics({ abi: memoAbi, eventName: "Memo", args: { sender: PAYER, target: USDC_ADDRESS, memoId } }),
      data: encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
        [keccak256(transferCalldata(M, amount)), memoBytes, 1n],
      ),
      logIndex: 4,
      blockNumber: 77n,
    } as unknown as Log;
    const [t] = extractTransfers([transferLog, memoLog], "0xdead");
    expect(t.to).toBe(M);
    expect(t.amount).toBe(amount);
    expect(t.memoId).toBe(memoId);
    expect(t.memoData).toBe(memoBytes);
  });

  it("returns a transfer with no memo when the hash does not match", () => {
    const transferLog = {
      address: USDC_ADDRESS,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER, to: M } }),
      data: encodeAbiParameters([{ type: "uint256" }], [1n]),
      logIndex: 0,
      blockNumber: 1n,
    } as unknown as Log;
    expect(extractTransfers([transferLog], "0x1")[0].memoId).toBeNull();
  });
});
