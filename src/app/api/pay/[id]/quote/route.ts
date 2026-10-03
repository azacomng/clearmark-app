import { handle, json } from "@/lib/http";
import { createQuote, invoiceState, LedgerError } from "@/lib/ledger";
import { rateLine } from "@/lib/fx";
import { eurPerUsdc } from "@/lib/rates";
import { write } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

/** Public: fix a USDC price for a EUR invoice's balance for 15 minutes. The quote id goes in the memo. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const rate = await eurPerUsdc();
  if (!rate) throw new LedgerError("The euro exchange rate is unavailable right now. Pay in EURC, or try again shortly.", 503);
  const now = new Date();
  const q = await write((db) => {
    const inv = db.invoices[id];
    if (!inv) throw new LedgerError("This payment link doesn't exist.", 404);
    return createQuote(db, id, BigInt(invoiceState(db, inv, now).balance), rate.rate, rate.source, now);
  });
  return json({ ...q, line: rateLine(q.rate) });
});
