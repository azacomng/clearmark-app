import { body, handle, json, requireMerchant } from "@/lib/http";
import { createRefund } from "@/lib/ledger";
import { toUnits } from "@/lib/money";
import { keyToPaymentId, refundView } from "@/lib/service";
import { write } from "@/lib/store";

/** Prepare a refund for a duplicate or overpayment. The merchant then sends it from their wallet. */
export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  const b = await body<{ payment: string; amount?: string }>(req);
  const amount = b.amount ? toUnits(b.amount).toString() : null;
  const r = await write((db) => refundView(db, createRefund(db, m, keyToPaymentId(String(b.payment)), amount, "manual", new Date())));
  return json(r, 201);
});
