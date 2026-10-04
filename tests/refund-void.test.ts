import { describe, expect, it } from "vitest";
import { memoText } from "@/lib/arc";
import {
  addResolution,
  assignPayment,
  cancelRefund,
  createInvoice,
  createRefund,
  ensureMerchant,
  invoiceState,
  markRefundSent,
  recordTransfer,
  voidInvoice,
  voidPayment,
} from "@/lib/ledger";
import { toUnits } from "@/lib/money";
import type { Db, Hex } from "@/lib/types";

const M = "0x4f2c000000000000000000000000000000091ae0" as Hex;
const PAYER = "0x9a1d00000000000000000000000000000000c07b" as Hex;
const now = new Date("2026-10-04T08:50:00Z");

let tx = 0;
const transfer = (amount: string, memoId: Hex | null) => ({
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
});

function setup(amount = "4") {
  const db: Db = { version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} };
  ensureMerchant(db, M, now, 1n);
  const inv = createInvoice(db, M, { title: "Logo", customerName: "Ada", amount, tolerance: "0", dueDate: "2026-10-30" }, now);
  const pay = (a: string) => recordTransfer(db, transfer(a, inv.memoId), now)!;
  return { db, inv, pay };
}

const sendDemo = (db: Db, id: string) => {
  const r = db.refunds[id];
  return markRefundSent(db, M, id, { txHash: `0x${"f".repeat(63)}${tx++ % 10}` as Hex, blockNumber: 99n, timestamp: now.toISOString(), from: M, to: r.to, amount: BigInt(r.amount), memoId: r.memoId, token: "USDC" });
};

describe("refunds on every extra payment", () => {
  it("lets each extra or duplicate payment be refunded on its own", () => {
    // The screenshot case: a 4.00 invoice paid exactly, then 6.00, 5.00, 5.00 and 2.50 more.
    const { db, inv, pay } = setup("4");
    pay("4");
    const extra = [pay("6"), pay("5"), pay("5"), pay("2.50")];
    const st = invoiceState(db, inv, now);
    expect(st.payments.map((c) => c.cls)).toEqual(["exact", "excess", "excess", "duplicate", "excess"]);
    for (const p of extra) {
      const r = createRefund(db, M, p.id, null, "manual", now);
      expect(r.amount).toBe(p.amount);
      sendDemo(db, r.id);
    }
    const after = invoiceState(db, inv, now);
    expect(after.status).toBe("paid");
    expect(after.variant).toBe("refunded");
  });
});

describe("void with a reason", () => {
  it("voids an unpaid invoice and records who, when and why", () => {
    const { db, inv } = setup();
    expect(() => voidInvoice(db, M, inv.id, " ", now)).toThrow(/reason/);
    voidInvoice(db, M, inv.id, "Customer cancelled", now);
    expect(inv.voided).toBe(true);
    expect(inv.voidInfo).toEqual({ reason: "Customer cancelled", by: M, at: now.toISOString() });
    expect(invoiceState(db, inv, now).status).toBe("void");
    expect(() => voidInvoice(db, M, inv.id, "Again", now)).toThrow(/already void/);
  });

  it("won't void an invoice that received money", () => {
    const { db, inv, pay } = setup();
    pay("2");
    expect(() => voidInvoice(db, M, inv.id, "Customer cancelled", now)).toThrow(/received money/);
  });

  it("drops a voided payment from the invoice but keeps it in the ledger", () => {
    const { db, inv, pay } = setup();
    pay("4");
    const dup = pay("4");
    expect(invoiceState(db, inv, now).status).toBe("duplicate");
    expect(() => voidPayment(db, M, dup.id, "", now)).toThrow(/reason/);
    voidPayment(db, M, dup.id, "Test payment", now);
    expect(db.payments[dup.id].voided?.reason).toBe("Test payment");
    const st = invoiceState(db, inv, now);
    expect(st.status).toBe("paid");
    expect(st.received).toBe(toUnits("4").toString());
    expect(() => voidPayment(db, M, dup.id, "Again", now)).toThrow(/already void/);
    expect(() => createRefund(db, M, dup.id, null, "manual", now)).toThrow(/voided/);
    expect(() => assignPayment(db, M, dup.id, inv.id)).toThrow(/voided/);
  });

  it("re-judges the remaining payments after a void", () => {
    const { db, inv, pay } = setup();
    const first = pay("4");
    pay("6");
    voidPayment(db, M, first.id, "Not for this invoice", now);
    const st = invoiceState(db, inv, now);
    expect(st.status).toBe("overpaid");
    expect(st.excessOpen).toBe(toUnits("2").toString());
  });

  it("won't void a payment that has a refund or a credit", () => {
    const { db, inv, pay } = setup();
    pay("4");
    const a = pay("4");
    const b = pay("5");
    const r = createRefund(db, M, a.id, null, "manual", now);
    expect(() => voidPayment(db, M, a.id, "Sent by mistake", now)).toThrow(/refund/);
    cancelRefund(db, M, r.id);
    voidPayment(db, M, a.id, "Sent by mistake", now);
    addResolution(db, M, inv.id, "credit", b.id, now);
    expect(() => voidPayment(db, M, b.id, "Sent by mistake", now)).toThrow(/credit/);
  });

  it("won't void a payment if that would undo a credit on another one", () => {
    const { db, inv, pay } = setup();
    const first = pay("4");
    const extra = pay("6");
    addResolution(db, M, inv.id, "credit", extra.id, now); // 6.00 kept as credit
    // Without the first payment, the 6.00 would pay the invoice with only 2.00 extra.
    expect(() => voidPayment(db, M, first.id, "Sent by mistake", now)).toThrow(/undo a refund or credit/);
    expect(db.payments[first.id].voided).toBeFalsy();
    expect(invoiceState(db, inv, now).status).toBe("paid");
  });
});
