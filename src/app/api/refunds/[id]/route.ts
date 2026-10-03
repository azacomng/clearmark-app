import { verifyMessage } from "viem";
import { asTxHash, body, handle, json, requireMerchant } from "@/lib/http";
import { approveRefund, cancelRefund, LedgerError } from "@/lib/ledger";
import { approvalMessage } from "@/lib/receipts";
import { confirmRefundTx, refundView } from "@/lib/service";
import { read, write } from "@/lib/store";
import type { Hex } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { id } = await ctx.params;
  const db = await read();
  const r = db.refunds[id];
  if (!r || r.merchant !== m) throw new LedgerError("Refund not found", 404);
  return json({ ...refundView(db, r), approvalMessage: approvalMessage(r) });
});

/**
 * approve: second approval for large refunds, confirmed with a wallet signature.
 * confirm: record the refund after verifying its transaction onchain.
 * cancel: drop a refund that hasn't been sent.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { id } = await ctx.params;
  const b = await body<{ action: "approve" | "confirm" | "cancel"; signature?: Hex; txHash?: string }>(req);
  if (b.action === "approve") {
    const r = (await read()).refunds[id];
    if (!r || r.merchant !== m) throw new LedgerError("Refund not found", 404);
    const ok = b.signature && (await verifyMessage({ address: m, message: approvalMessage(r), signature: b.signature }));
    if (!ok) throw new LedgerError("The approval signature didn't check out.", 401);
    return json(await write((db) => approveRefund(db, m, id, new Date())));
  }
  if (b.action === "confirm") return json(await confirmRefundTx(m, id, asTxHash(b.txHash)));
  if (b.action === "cancel") {
    await write((db) => cancelRefund(db, m, id));
    return json({ ok: true });
  }
  throw new LedgerError("Unknown action");
});
