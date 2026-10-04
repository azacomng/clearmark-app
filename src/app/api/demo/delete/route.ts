import { body, handle, json, requireMerchant } from "@/lib/http";
import { deleteDemoPayment } from "@/lib/ledger";
import { keyToPaymentId } from "@/lib/service";
import { write } from "@/lib/store";

/** Undo a simulated payment: delete it with its simulated refunds and receipt. Real payments can only be voided. */
export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  const b = await body<{ payment: string }>(req);
  const pid = keyToPaymentId(String(b.payment));
  return json(await write((db) => deleteDemoPayment(db, m, pid, new Date())));
});
