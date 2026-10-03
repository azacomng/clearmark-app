import { handle, json } from "@/lib/http";
import { LedgerError, merchantPayments } from "@/lib/ledger";
import { checkoutCheck } from "@/lib/limits";
import { toUnits } from "@/lib/money";
import { publicInvoice } from "@/lib/service";
import { read } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

/** Public: what the payment link shows. Optional ?amount=&from= runs the limit check for a payer. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const db = await read();
  const inv = db.invoices[id];
  if (!inv) throw new LedgerError("This payment link doesn't exist.", 404);
  const view = publicInvoice(db, inv);
  const q = new URL(req.url).searchParams;
  if (q.get("amount")) {
    const c = checkoutCheck(db.merchants[inv.merchant].limits, toUnits(q.get("amount")!), merchantPayments(db, inv.merchant), new Date().toISOString(), q.get("from"));
    view.checkout = { ok: c.ok, maxAmount: c.maxAmount === null ? null : c.maxAmount.toString(), reason: c.reason };
  }
  return json(view);
});
