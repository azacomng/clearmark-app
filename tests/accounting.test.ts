import { describe, expect, it } from "vitest";
import { memoText } from "@/lib/arc";
import { addResolution, createInvoice, ensureMerchant, recordTransfer, voidInvoice } from "@/lib/ledger";
import { toUnits } from "@/lib/money";
import { bookInvoice, bookInvoices, bookTransactions } from "@/lib/accounting/model";
import { formatDate, quickbooksInvoicesCsv, quickbooksStatementCsv, xeroInvoicesCsv, xeroStatementCsv, XERO_INVOICE_HEADER } from "@/lib/accounting/csv";
import type { Db, Hex } from "@/lib/types";

const M = "0x4f2c000000000000000000000000000000091ae0" as Hex;
const PAYER = "0x9a1d00000000000000000000000000000000c07b" as Hex;
const now = new Date("2026-09-28T12:00:00Z");
const ORIGIN = "https://clearmark.example";
const fresh = (): Db => ({ version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });

let tx = 0;
const transfer = (amount: string, memoId: Hex | null, extra: Partial<Parameters<typeof recordTransfer>[1]> = {}) => ({
  source: "chain" as const,
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

function setup(extra: Partial<Parameters<typeof createInvoice>[2]> = {}) {
  const db = fresh();
  ensureMerchant(db, M, now, 1n);
  const inv = createInvoice(db, M, { title: "Website design", customerName: "Northwind, Ltd", amount: "250", tolerance: "0.5", dueDate: "2026-10-30", ...extra }, now);
  return { db, inv };
}

const total = (db: Db, id: string) => {
  const b = bookInvoice(db, db.invoices[id], ORIGIN, now);
  return { b, total: b.total.toString(), applied: b.payments.reduce((a, p) => a + p.amount, 0n).toString() };
};

describe("accounting model", () => {
  it("an open invoice is one line at face value with no payments", () => {
    const { db, inv } = setup();
    const { b } = total(db, inv.id);
    expect(b.lines).toEqual([{ description: "Website design", amount: toUnits("250") }]);
    expect(b.payments).toEqual([]);
    expect(b.settled).toBe(false);
    expect(b.currency).toBe("USD");
  });

  it("a paid invoice closes exactly: the total equals what was applied", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("250", inv.memoId), now);
    const t = total(db, inv.id);
    expect(t.b.settled).toBe(true);
    expect(t.total).toBe(t.applied);
    expect(t.b.lines).toHaveLength(1);
  });

  it("a payment within tolerance gets a tolerance line so the invoice closes", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("249.7", inv.memoId), now);
    const t = total(db, inv.id);
    expect(t.total).toBe(toUnits("249.7").toString());
    expect(t.b.lines.at(-1)).toEqual({ description: "Accepted within payment tolerance", amount: -toUnits("0.3") });
  });

  it("an overpayment only applies the invoice amount; the extra stays out of the invoice", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("300", inv.memoId), now);
    const t = total(db, inv.id);
    expect(t.applied).toBe(toUnits("250").toString());
    expect(t.total).toBe(t.applied);
  });

  it("a duplicate is not applied", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("250", inv.memoId), now);
    recordTransfer(db, transfer("250", inv.memoId), now);
    const t = total(db, inv.id);
    expect(t.b.payments).toHaveLength(1);
    expect(t.total).toBe(toUnits("250").toString());
  });

  it("part payments stay open until covered", () => {
    const { db, inv } = setup({ allowSplit: true });
    recordTransfer(db, transfer("100", inv.memoId, { memoData: memoText({ pay: "part" }) }), now);
    let t = total(db, inv.id);
    expect(t.b.settled).toBe(false);
    expect(t.total).toBe(toUnits("250").toString());
    recordTransfer(db, transfer("150", inv.memoId, { memoData: memoText({ pay: "part" }) }), now);
    t = total(db, inv.id);
    expect(t.b.settled).toBe(true);
    expect(t.b.payments).toHaveLength(2);
    expect(t.total).toBe(t.applied);
  });

  it("an early-pay discount becomes its own line", () => {
    const { db, inv } = setup({ terms: { earlyPct: "2", earlyDays: "3" } });
    recordTransfer(db, transfer("245", inv.memoId), now);
    const t = total(db, inv.id);
    expect(t.b.lines[1]).toEqual({ description: "Early-payment discount", amount: -toUnits("5") });
    expect(t.total).toBe(t.applied);
  });

  it("a written-off balance becomes its own line", () => {
    const { db, inv } = setup({ tolerance: "0" });
    recordTransfer(db, transfer("200", inv.memoId), now);
    addResolution(db, M, inv.id, "write_off", null, now);
    const t = total(db, inv.id);
    expect(t.b.settled).toBe(true);
    expect(t.b.lines).toContainEqual({ description: "Written off in Clearmark", amount: -toUnits("50") });
    expect(t.total).toBe(t.applied);
  });

  it("rounds to cents and still closes exactly", () => {
    const { db, inv } = setup({ amount: "10.004", tolerance: "0.01" });
    recordTransfer(db, transfer("3.333333", inv.memoId, { memoData: memoText({ pay: "part" }) }), now);
    recordTransfer(db, transfer("6.666666", inv.memoId, { memoData: memoText({ pay: "part" }) }), now);
    const t = total(db, inv.id);
    expect(t.b.lines[0].amount).toBe(toUnits("10"));
    expect(t.b.payments.map((p) => p.amount)).toEqual([toUnits("3.33"), toUnits("6.67")]);
    expect(t.total).toBe(t.applied);
  });

  it("simulated payments never reach the books", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("250", inv.memoId, { source: "demo" }), now);
    const t = total(db, inv.id);
    expect(t.b.payments).toEqual([]);
    expect(t.b.settled).toBe(false);
    expect(bookTransactions(db, M, "USDC", now)).toEqual([]);
  });

  it("EUR invoices are in EUR", () => {
    const { db } = setup();
    const e = createInvoice(db, M, { title: "Retainer", customerName: "Acme", amount: "100", tolerance: "0", dueDate: "2026-10-30", currency: "EUR" }, now);
    expect(bookInvoice(db, e, ORIGIN, now).currency).toBe("EUR");
  });
});

describe("csv exports", () => {
  it("formats dates", () => {
    expect(formatDate("2026-10-05", "iso")).toBe("2026-10-05");
    expect(formatDate("2026-10-05", "dmy")).toBe("05/10/2026");
    expect(formatDate("2026-10-05", "mdy")).toBe("10/05/2026");
  });

  it("Xero invoices follow the template columns, one row per line, quoting commas", () => {
    const { db, inv } = setup();
    recordTransfer(db, transfer("249.7", inv.memoId), now);
    const out = xeroInvoicesCsv(bookInvoices(db, M, ORIGIN, now), { dateFormat: "dmy", accountCode: "200", taxType: "Tax Exempt" });
    const lines = out.trim().split("\r\n");
    expect(lines[0]).toBe(XERO_INVOICE_HEADER.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Northwind, Ltd"');
    expect(lines[1]).toContain(",INV-10001,");
    expect(lines[1]).toContain(",28/09/2026,30/10/2026,");
    expect(lines[1]).toContain(",Website design,1,250.00,,200,Tax Exempt,");
    expect(lines[2]).toContain(",Accepted within payment tolerance,1,-0.30,");
    expect(lines[1].endsWith(",USD,")).toBe(true);
    expect(lines[1].split(",").length).toBe(XERO_INVOICE_HEADER.length + 1); // +1 for the comma inside the quoted name
  });

  it("leaves voided invoices out of invoice files", () => {
    const { db, inv } = setup();
    voidInvoice(db, M, inv.id, "Created by mistake", now);
    const books = bookInvoices(db, M, ORIGIN, now);
    expect(xeroInvoicesCsv(books, { dateFormat: "iso", accountCode: "200", taxType: "Tax Exempt" }).trim().split("\r\n")).toHaveLength(1);
    expect(quickbooksInvoicesCsv(books, { dateFormat: "iso", item: "Services" }).trim().split("\r\n")).toHaveLength(1);
  });

  it("QuickBooks invoices use its sample columns", () => {
    const { db } = setup();
    const out = quickbooksInvoicesCsv(bookInvoices(db, M, ORIGIN, now), { dateFormat: "mdy", item: "Services" });
    const [head, row] = out.trim().split("\r\n");
    expect(head).toBe("*InvoiceNo,*Customer,*InvoiceDate,*DueDate,Terms,Location,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,*ItemAmount,Currency");
    expect(row.startsWith('INV-10001,"Northwind, Ltd",09/28/2026,10/30/2026,')).toBe(true);
    expect(row.endsWith(",Services,Website design,1,250.00,250.00,USD")).toBe(true);
  });

  it("bank statements carry money in and out with the tx hash", () => {
    const { db, inv } = setup();
    const p = recordTransfer(db, transfer("250", inv.memoId), now)!;
    const txns = bookTransactions(db, M, "USDC", now);
    const x = xeroStatementCsv(txns, "iso").trim().split("\r\n");
    expect(x[0]).toBe("Date,Amount,Payee,Description,Reference");
    expect(x[1]).toBe(`2026-09-28,250.00,"Northwind, Ltd",Payment received · INV-10001 · PAID,${p.txHash}`);
    const q = quickbooksStatementCsv(txns, "mdy").trim().split("\r\n");
    expect(q[0]).toBe("Date,Description,Amount");
    expect(q[1]).toBe(`09/28/2026,"Northwind, Ltd · Payment received · INV-10001 · PAID · ${p.txHash}",250.00`);
    expect(bookTransactions(db, M, "EURC", now)).toEqual([]);
  });

  it("keeps spreadsheet formulas out of text cells", () => {
    const { db } = setup({ customerName: "=HYPERLINK(1)" });
    const out = quickbooksInvoicesCsv(bookInvoices(db, M, ORIGIN, now), { dateFormat: "iso", item: "Services" });
    expect(out).toContain(",'=HYPERLINK(1),");
  });
});
