import { asTxHash, body, handle, json } from "@/lib/http";
import { LedgerError, recordSettleTime } from "@/lib/ledger";
import { confirmTx, paymentKey, publicInvoice } from "@/lib/service";
import { read, write } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

/** Public: the checkout reports its transaction hash. We verify it onchain; nothing is trusted from the client. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { txHash, settleMs } = await body<{ txHash: string; settleMs?: number }>(req);
  const db0 = await read();
  if (!db0.invoices[id]) throw new LedgerError("This payment link doesn't exist.", 404);
  const recorded = await confirmTx(asTxHash(txHash));
  const mine = recorded.filter((p) => p.invoiceId === id);
  if (mine.length && settleMs !== undefined) await write((db) => recordSettleTime(db, mine.map((p) => p.id), settleMs, new Date()));
  const db = await read();
  return json({ invoice: publicInvoice(db, db.invoices[id]), receipts: mine.map((p) => `/r/p/${paymentKey(p)}`), matched: mine.length > 0 });
});
