import { handle, json, requireMerchant } from "@/lib/http";
import { LedgerError } from "@/lib/ledger";
import { isProvider } from "@/lib/accounting/providers";
import { accountOptions } from "@/lib/accounting/sync";

type Ctx = { params: Promise<{ provider: string }> };

/** The merchant's own chart of accounts, to choose where sales and payments are booked. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const { provider: p } = await ctx.params;
  if (!isProvider(p)) throw new LedgerError("Unknown accounting system.", 404);
  try {
    return json(await accountOptions(m, p));
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError((e as Error).message, 502);
  }
});
