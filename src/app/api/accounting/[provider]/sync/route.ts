import { handle, json, requestOrigin, requireMerchant } from "@/lib/http";
import { LedgerError } from "@/lib/ledger";
import { isProvider } from "@/lib/accounting/providers";
import { syncAccounting } from "@/lib/accounting/sync";

type Ctx = { params: Promise<{ provider: string }> };

export const maxDuration = 120;

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { provider: p } = await ctx.params;
  if (!isProvider(p)) throw new LedgerError("Unknown accounting system.", 404);
  try {
    return json(await syncAccounting(m, p, requestOrigin(req)));
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError((e as Error).message, 502);
  }
});
