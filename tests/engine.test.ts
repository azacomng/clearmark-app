import { describe, expect, it } from "vitest";
import { reconcile } from "@/lib/engine";
import { toUnits } from "@/lib/money";
import type { Invoice, Payment } from "@/lib/types";

const inv = (o: Partial<Invoice> = {}): Invoice => ({
  id: "inv1",
  merchant: "0xm",
  number: "INV-10482",
  title: "Website design",
  customerName: "Northwind",
  customerEmail: null,
  amount: toUnits("250").toString(),
  tolerance: toUnits("0.50").toString(),
  dueDate: "2026-09-30",
  allowSplit: true,
  memoId: "0x01",
  createdAt: "2026-09-01T00:00:00Z",
  voided: false,
  resolutions: [],
  ...o,
});

let n = 0;
const pay = (amount: string, o: Partial<Payment> = {}): Payment => {
  n++;
  return {
    id: `p${n}`,
    merchant: "0xm",
    source: "demo",
    txHash: `0x${n}`,
    logIndex: 0,
    blockNumber: String(n),
    timestamp: "2026-09-28T12:00:00Z",
    from: "0xpayer",
    to: "0xm",
    amount: toUnits(amount).toString(),
    memoId: "0x01",
    memoText: null,
    intent: "full",
    invoiceId: "inv1",
    matchMethod: "memo",
    hold: null,
    recordedAt: "2026-09-28T12:00:00Z",
    ...o,
  };
};

const before = new Date("2026-09-28T12:00:00Z");
const after = new Date("2026-10-05T12:00:00Z");

describe("reconcile", () => {
  it("open with no payments", () => {
    expect(reconcile(inv(), [], before).label).toBe("OPEN");
  });

  it("$250 -> PAID", () => {
    const s = reconcile(inv(), [pay("250")], before);
    expect(s.label).toBe("PAID");
    expect(s.payments[0].cls).toBe("exact");
  });

  it("$200 -> UNDERPAID with 50 balance", () => {
    const s = reconcile(inv(), [pay("200")], before);
    expect(s.status).toBe("underpaid");
    expect(s.balance).toBe(toUnits("50").toString());
  });

  it("$300 -> OVERPAID with 50 excess", () => {
    const s = reconcile(inv(), [pay("300")], before);
    expect(s.status).toBe("overpaid");
    expect(s.excessOpen).toBe(toUnits("50").toString());
  });

  it("$250 twice -> DUPLICATE", () => {
    const s = reconcile(inv(), [pay("250"), pay("250")], before);
    expect(s.status).toBe("duplicate");
    expect(s.payments.map((p) => p.cls)).toEqual(["exact", "duplicate"]);
    expect(s.duplicateOpen).toBe(toUnits("250").toString());
  });

  it("$125 part + $125 -> PARTIAL then PAID · SPLIT", () => {
    const a = pay("125", { intent: "part" });
    expect(reconcile(inv(), [a], before).status).toBe("partial");
    const s = reconcile(inv(), [a, pay("125", { intent: "part" })], before);
    expect(s.label).toBe("PAID · SPLIT");
  });

  it("a part payment becomes UNDERPAID once overdue", () => {
    expect(reconcile(inv(), [pay("125", { intent: "part" })], after).status).toBe("underpaid");
  });

  it("249.70 within 0.50 tolerance -> PAID · WITHIN TOLERANCE", () => {
    expect(reconcile(inv(), [pay("249.70")], before).label).toBe("PAID · WITHIN TOLERANCE");
  });

  it("249.40 outside tolerance -> UNDERPAID", () => {
    expect(reconcile(inv(), [pay("249.40")], before).status).toBe("underpaid");
  });

  it("held payments do not count until accepted", () => {
    const held = pay("250", { hold: { reason: "over_max", detail: "", resolution: null } });
    expect(reconcile(inv(), [held], before).status).toBe("open");
    held.hold!.resolution = "accepted";
    expect(reconcile(inv(), [held], before).status).toBe("paid");
  });

  it("refunding a duplicate settles the invoice", () => {
    const a = pay("250");
    const b = pay("250");
    const i = inv({ resolutions: [{ id: "r", kind: "refund", paymentId: b.id, amount: b.amount, at: "" }] });
    expect(reconcile(i, [a, b], before).label).toBe("PAID · REFUNDED");
  });

  it("crediting an overpayment settles the invoice", () => {
    const a = pay("300");
    const i = inv({ resolutions: [{ id: "r", kind: "credit", paymentId: a.id, amount: toUnits("50").toString(), at: "" }] });
    expect(reconcile(i, [a], before).label).toBe("PAID · CREDITED");
  });

  it("writing off a short balance closes it", () => {
    const i = inv({ resolutions: [{ id: "r", kind: "write_off", paymentId: null, amount: toUnits("50").toString(), at: "" }] });
    expect(reconcile(i, [pay("200")], before).label).toBe("PAID · WRITTEN OFF");
  });

  it("an extra payment of a different amount after paid is excess (overpaid)", () => {
    const s = reconcile(inv(), [pay("250"), pay("10")], before);
    expect(s.status).toBe("overpaid");
    expect(s.payments[1].cls).toBe("excess");
  });

  it("orders payments by block, not by input order", () => {
    const late = pay("250", { blockNumber: "100" });
    const early = pay("250", { blockNumber: "50" });
    const s = reconcile(inv(), [late, early], before);
    expect(s.payments[0].id).toBe(early.id);
    expect(s.payments[1].cls).toBe("duplicate");
  });
});
