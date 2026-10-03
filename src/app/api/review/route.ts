import { body, handle, json, requireMerchant } from "@/lib/http";
import { assignPayment, LedgerError, resolveHold } from "@/lib/ledger";
import { keyToPaymentId, reviewItems } from "@/lib/service";
import { read, write } from "@/lib/store";

export const GET = handle(async () => {
  const m = await requireMerchant();
  return json(reviewItems(await read(), m));
});

/** assign: match an untagged payment to an invoice. accept/return: resolve a held payment. */
export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  const b = await body<{ action: "assign" | "accept" | "return"; payment: string; invoiceId?: string | null }>(req);
  const pid = keyToPaymentId(String(b.payment));
  const now = new Date();
  const out = await write((db) => {
    if (b.action === "assign") return { payment: assignPayment(db, m, pid, b.invoiceId ?? null), refund: null };
    if (b.action === "accept" || b.action === "return") return resolveHold(db, m, pid, b.action, now);
    throw new LedgerError("Unknown action");
  });
  return json(out);
});
