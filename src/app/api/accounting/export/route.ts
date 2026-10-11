import { handle, requestOrigin, requireMerchant } from "@/lib/http";
import { LedgerError } from "@/lib/ledger";
import { bookInvoices, bookTransactions } from "@/lib/accounting/model";
import { quickbooksInvoicesCsv, quickbooksStatementCsv, xeroInvoicesCsv, xeroStatementCsv, type DateFormat } from "@/lib/accounting/csv";
import { read } from "@/lib/store";

/**
 * GET /api/accounting/export?target=xero|quickbooks&file=invoices|transactions
 *   &token=USDC|EURC (transactions) &dates=iso|dmy|mdy &month=YYYY-MM (optional)
 *   &account=200&tax=Tax+Exempt (Xero invoices) &item=Services (QuickBooks invoices)
 */
export const GET = handle(async (req: Request) => {
  const m = await requireMerchant();
  const q = new URL(req.url).searchParams;
  const target = q.get("target");
  const file = q.get("file");
  if (target !== "xero" && target !== "quickbooks") throw new LedgerError("Choose Xero or QuickBooks.");
  if (file !== "invoices" && file !== "transactions") throw new LedgerError("Choose invoices or transactions.");
  const dates = (["iso", "dmy", "mdy"] as const).find((d) => d === q.get("dates")) ?? "iso";
  const month = q.get("month") ?? "";
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw new LedgerError("Month must look like 2026-10.");
  const text = (k: string, fallback: string) => (q.get(k)?.trim() || fallback).slice(0, 60);
  const db = await read();

  let body: string;
  let name: string;
  if (file === "invoices") {
    const invoices = bookInvoices(db, m, requestOrigin(req)).filter((i) => !month || i.issueDate.startsWith(month));
    body =
      target === "xero"
        ? xeroInvoicesCsv(invoices, { dateFormat: dates as DateFormat, accountCode: text("account", "200"), taxType: text("tax", "Tax Exempt") })
        : quickbooksInvoicesCsv(invoices, { dateFormat: dates as DateFormat, item: text("item", "Services") });
    name = `clearmark-${target}-invoices`;
  } else {
    const token = q.get("token") === "EURC" ? "EURC" : "USDC";
    const txns = bookTransactions(db, m, token).filter((t) => !month || t.date.startsWith(month));
    body = target === "xero" ? xeroStatementCsv(txns, dates) : quickbooksStatementCsv(txns, dates);
    name = `clearmark-${target}-${token.toLowerCase()}-transactions`;
  }
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}${month ? "-" + month : ""}.csv"`,
      "cache-control": "no-store",
    },
  });
});
