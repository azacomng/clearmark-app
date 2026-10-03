import { asTxHash, body, handle, json, requireMerchant } from "@/lib/http";
import { cancelPayout, LedgerError, markPayoutSent } from "@/lib/ledger";
import { confirmPayoutTx, DEMO, demoTxHash } from "@/lib/service";
import { write } from "@/lib/store";
import { big } from "@/lib/money";

type Ctx = { params: Promise<{ id: string }> };

/**
 * confirm: record the payout after verifying its batch transaction onchain.
 * simulate: demo mode, for payouts on simulated payments.
 * cancel: drop a payout that hasn't been sent.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { id } = await ctx.params;
  const b = await body<{ action: "confirm" | "simulate" | "cancel"; txHash?: string }>(req);
  if (b.action === "confirm") return json(await confirmPayoutTx(m, id, asTxHash(b.txHash)));
  if (b.action === "cancel") {
    await write((db) => cancelPayout(db, m, id));
    return json({ ok: true });
  }
  if (b.action === "simulate") {
    if (!DEMO) throw new LedgerError("Demo mode is off.", 404);
    return json(
      await write((db) => {
        const p = db.payouts?.[id];
        if (!p || p.merchant !== m) throw new LedgerError("Payout not found", 404);
        if (p.source !== "demo") throw new LedgerError("This payout is for real testnet payments. Send it from your wallet.");
        return markPayoutSent(db, m, id, {
          txHash: demoTxHash(id),
          blockNumber: BigInt(Date.now()),
          timestamp: new Date().toISOString(),
          transfers: p.lines.map((l) => ({ from: m, to: l.address, amount: big(l.amount), token: p.token })),
        });
      }),
    );
  }
  throw new LedgerError("Unknown action");
});
