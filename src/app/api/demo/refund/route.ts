import { body, handle, json, requireMerchant } from "@/lib/http";
import { LedgerError, markRefundSent } from "@/lib/ledger";
import { big } from "@/lib/money";
import { DEMO, demoTxHash } from "@/lib/service";
import { write } from "@/lib/store";

/** Demo mode only: mark a refund as sent with a simulated transaction. Only for refunds of simulated payments. */
export const POST = handle(async (req: Request) => {
  if (!DEMO) throw new LedgerError("Demo mode is off.", 404);
  const m = await requireMerchant();
  const { refundId } = await body<{ refundId: string }>(req);
  const r = await write((db) => {
    const r = db.refunds[refundId];
    if (!r || r.merchant !== m) throw new LedgerError("Refund not found", 404);
    if (r.source !== "demo") throw new LedgerError("This refund is for a real testnet payment. Send it from your wallet.");
    return markRefundSent(db, m, refundId, {
      txHash: demoTxHash(refundId),
      blockNumber: BigInt(Date.now()),
      timestamp: new Date().toISOString(),
      from: m,
      to: r.to,
      amount: big(r.amount),
      memoId: r.memoId,
    });
  });
  return json(r);
});
