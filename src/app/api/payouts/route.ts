import { body, handle, json, requireMerchant } from "@/lib/http";
import { createPayout } from "@/lib/ledger";
import { write } from "@/lib/store";

/** Prepare the collaborator payout for a paid invoice. The merchant then sends it in one batch. */
export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  const { invoiceId } = await body<{ invoiceId: string }>(req);
  return json(await write((db) => createPayout(db, m, String(invoiceId), new Date())), 201);
});
