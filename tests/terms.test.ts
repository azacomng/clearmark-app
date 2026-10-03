import { describe, expect, it } from "vitest";
import { reconcile } from "@/lib/engine";
import { createInvoice, ensureMerchant, recordSettleTime } from "@/lib/ledger";
import { toUnits } from "@/lib/money";
import { earlyDeadline, parseTerms, priceAt, termsLine } from "@/lib/terms";
import type { Db, Hex, Invoice, Payment } from "@/lib/types";

// 250 USDC, created 1 Sep, due 30 Sep, 2% off within 3 days, 1.5% late fee.
const inv = (o: Partial<Invoice> = {}): Invoice => ({
  id: "inv1",
  merchant: "0xm",
  number: "INV-10001",
  title: "Website design",
  customerName: "Northwind",
  customerEmail: null,
  amount: toUnits("250").toString(),
  tolerance: toUnits("0.50").toString(),
  dueDate: "2026-09-30",
  allowSplit: true,
  memoId: "0x01",
  createdAt: "2026-09-01T00:00:00.000Z",
  voided: false,
  resolutions: [],
  terms: { earlyBps: 200, earlyDays: 3, lateBps: 150 },
  ...o,
});

let n = 0;
const pay = (amount: string, timestamp: string, o: Partial<Payment> = {}): Payment => {
  n++;
  return {
    id: `p${n}`,
    merchant: "0xm",
    source: "demo",
    txHash: `0x${n}`,
    logIndex: 0,
    blockNumber: String(n),
    timestamp,
    from: "0xpayer",
    to: "0xm",
    amount: toUnits(amount).toString(),
    memoId: "0x01",
    memoText: null,
    intent: "full",
    invoiceId: "inv1",
    matchMethod: "memo",
    hold: null,
    recordedAt: timestamp,
    ...o,
  };
};

const DAY2 = "2026-09-03T10:00:00.000Z";
const DAY10 = "2026-09-10T10:00:00.000Z";
const LATE = "2026-10-02T10:00:00.000Z";

describe("priceAt", () => {
  it("applies the discount inside the window, the base price after, the fee once overdue", () => {
    expect(priceAt(inv(), DAY2)).toEqual({ amount: toUnits("245"), kind: "early" });
    expect(priceAt(inv(), DAY10)).toEqual({ amount: toUnits("250"), kind: "standard" });
    expect(priceAt(inv(), LATE)).toEqual({ amount: toUnits("253.75"), kind: "late" });
  });

  it("is the plain amount with no terms", () => {
    expect(priceAt(inv({ terms: null }), LATE)).toEqual({ amount: toUnits("250"), kind: "standard" });
  });

  it("ends the discount exactly at the deadline", () => {
    const d = earlyDeadline(inv())!;
    expect(d).toBe("2026-09-04T00:00:00.000Z");
    expect(priceAt(inv(), d).kind).toBe("early");
    expect(priceAt(inv(), "2026-09-04T00:00:00.001Z").kind).toBe("standard");
  });

  it("states the terms in one line", () => {
    expect(termsLine(inv())).toBe("2% off if paid within 3 days (245.00 USDC) · 1.5% late fee after the due date");
  });
});

describe("reconcile with Smart Terms", () => {
  it("245 paid inside the window -> PAID · EARLY DISCOUNT", () => {
    const s = reconcile(inv(), [pay("245", DAY2)], new Date(DAY10));
    expect(s.label).toBe("PAID · EARLY DISCOUNT");
    expect(s.balance).toBe("0");
    expect(s.price).toBe(toUnits("245").toString());
    expect(s.payments[0].cls).toBe("exact");
  });

  it("245 paid after the window is short by 5", () => {
    const s = reconcile(inv(), [pay("245", DAY10)], new Date(DAY10));
    expect(s.status).toBe("underpaid");
    expect(s.balance).toBe(toUnits("5").toString());
  });

  it("an open invoice shows the price that applies now", () => {
    expect(reconcile(inv(), [], new Date(DAY2)).price).toBe(toUnits("245").toString());
    expect(reconcile(inv(), [], new Date(LATE)).balance).toBe(toUnits("253.75").toString());
  });

  it("the discount locks at settle time, so later views stay paid", () => {
    const s = reconcile(inv(), [pay("245", DAY2)], new Date(LATE));
    expect(s.status).toBe("paid");
    expect(s.overdue).toBe(false);
  });

  it("paying 250 inside the window is an overpayment of 5", () => {
    const s = reconcile(inv(), [pay("250", DAY2)], new Date(DAY2));
    expect(s.status).toBe("overpaid");
    expect(s.excessOpen).toBe(toUnits("5").toString());
  });

  it("253.75 after the due date -> PAID · WITH LATE FEE", () => {
    expect(reconcile(inv(), [pay("253.75", LATE)], new Date(LATE)).label).toBe("PAID · WITH LATE FEE");
  });

  it("250 after the due date is short by the late fee", () => {
    const s = reconcile(inv(), [pay("250", LATE)], new Date(LATE));
    expect(s.status).toBe("underpaid");
    expect(s.balance).toBe(toUnits("3.75").toString());
  });

  it("split parts only earn the discount if the last part lands inside the window", () => {
    const early = reconcile(inv(), [pay("120", DAY2, { intent: "part" }), pay("125", DAY2)], new Date(DAY2));
    expect(early.label).toBe("PAID · EARLY DISCOUNT");
    const missed = reconcile(inv(), [pay("120", DAY2, { intent: "part" }), pay("125", DAY10)], new Date(DAY10));
    expect(missed.status).toBe("underpaid");
    expect(missed.balance).toBe(toUnits("5").toString());
  });

  it("a second full payment at the base amount is still caught as a duplicate", () => {
    const s = reconcile(inv(), [pay("245", DAY2), pay("250", DAY10)], new Date(DAY10));
    expect(s.status).toBe("duplicate");
    expect(s.payments[1].cls).toBe("duplicate");
  });
});

describe("parseTerms", () => {
  const c = "2026-09-01T00:00:00.000Z";
  it("returns null when nothing is switched on", () => {
    expect(parseTerms({ earlyPct: "", latePct: "0" }, c, "2026-09-30")).toBeNull();
  });
  it("converts percentages to basis points", () => {
    expect(parseTerms({ earlyPct: "2", earlyDays: "3", latePct: "1.5" }, c, "2026-09-30")).toEqual({ earlyBps: 200, earlyDays: 3, lateBps: 150 });
  });
  it("rejects a window that runs past the due date", () => {
    expect(() => parseTerms({ earlyPct: "2", earlyDays: "30" }, c, "2026-09-10")).toThrow(/due date/);
  });
  it("caps the discount and the fee", () => {
    expect(() => parseTerms({ earlyPct: "25", earlyDays: "3" }, c, "2026-09-30")).toThrow(/at most 20%/);
    expect(() => parseTerms({ latePct: "30" }, c, "2026-09-30")).toThrow(/at most 25%/);
  });
});

describe("ledger", () => {
  const M = "0x4f2c000000000000000000000000000000091ae0" as Hex;
  const fresh = (): Db => ({ version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });
  const now = new Date("2026-09-01T00:00:00.000Z");

  it("stores terms on a new invoice and rejects bad ones", () => {
    const db = fresh();
    ensureMerchant(db, M, now, 1n);
    const i = createInvoice(db, M, { title: "Logo", customerName: "Acme", amount: "100", dueDate: "2026-09-30", terms: { earlyPct: "2", earlyDays: "5" } }, now);
    expect(i.terms).toEqual({ earlyBps: 200, earlyDays: 5, lateBps: 0 });
    expect(() => createInvoice(db, M, { title: "Logo", customerName: "Acme", amount: "100", dueDate: "2026-09-30", terms: { latePct: "-1" } }, now)).toThrow();
  });

  it("takes a checkout settle time once, for a fresh payment only", () => {
    const db = fresh();
    db.payments.a = pay("1", now.toISOString(), { id: "a" });
    db.payments.b = pay("1", "2026-08-01T00:00:00.000Z", { id: "b" });
    recordSettleTime(db, ["a", "b"], 820, now);
    recordSettleTime(db, ["a"], 5000, now);
    expect(db.payments.a.settleMs).toBe(820);
    expect(db.payments.b.settleMs).toBeUndefined();
    recordSettleTime(db, ["a"], "abc", now);
    expect(db.payments.a.settleMs).toBe(820);
  });
});
