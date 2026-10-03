import { body, handle, json, requireMerchant } from "@/lib/http";
import { addResolution, LedgerError, voidInvoice } from "@/lib/ledger";
import { invoiceView, paymentView, refundView } from "@/lib/service";
import { read, write } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { id } = await ctx.params;
  const db = await read();
  const inv = db.invoices[id];
  if (!inv || inv.merchant !== m) throw new LedgerError("Invoice not found", 404);
  const payments = Object.values(db.payments)
    .filter((p) => p.invoiceId === id)
    .map((p) => paymentView(db, p))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const refunds = Object.values(db.refunds).filter((r) => r.invoiceId === id).map((r) => refundView(db, r));
  return json({ invoice: invoiceView(db, inv), payments, refunds });
});

/** Actions on an invoice: write_off the balance, keep a payment's surplus as credit, or void. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { id } = await ctx.params;
  const b = await body<{ action: "write_off" | "credit" | "void"; paymentId?: string }>(req);
  const now = new Date();
  const result = await write((db) => {
    if (b.action === "void") voidInvoice(db, m, id, now);
    else if (b.action === "write_off") addResolution(db, m, id, "write_off", null, now);
    else if (b.action === "credit") addResolution(db, m, id, "credit", b.paymentId ?? null, now);
    else throw new LedgerError("Unknown action");
    return invoiceView(db, db.invoices[id], now);
  });
  return json(result);
});
