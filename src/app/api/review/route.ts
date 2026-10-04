import { body, handle, json, requireMerchant } from "@/lib/http";
import { assignPayment, LedgerError, resolveHold, voidPayment } from "@/lib/ledger";
import { eurPerUsdc } from "@/lib/rates";
import { keyToPaymentId, reviewItems } from "@/lib/service";
import { read, write } from "@/lib/store";

export const GET = handle(async () => {
  const m = await requireMerchant();
  return json(reviewItems(await read(), m));
});

/**
 * assign: match an untagged payment to an invoice. accept/return: resolve a held payment.
 * void: dismiss a payment with a reason. It stays in history, crossed out, and stops counting.
 */
export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  const b = await body<{ action: "assign" | "accept" | "return" | "void"; payment: string; invoiceId?: string | null; reason?: string }>(req);
  const pid = keyToPaymentId(String(b.payment));
  const now = new Date();
  // A payment held for a missing exchange rate is accepted at the current reference rate.
  const pending = (await read()).payments[pid];
  const rate = b.action === "accept" && pending?.hold?.reason === "fx_missing" ? await eurPerUsdc() : null;
  const out = await write((db) => {
    if (b.action === "assign") return { payment: assignPayment(db, m, pid, b.invoiceId ?? null), refund: null };
    if (b.action === "accept" || b.action === "return") return resolveHold(db, m, pid, b.action, now, rate);
    if (b.action === "void") return { payment: voidPayment(db, m, pid, b.reason, now), refund: null };
    throw new LedgerError("Unknown action");
  });
  return json(out);
});
