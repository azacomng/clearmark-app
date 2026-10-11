import { body, handle, json, requireMerchant } from "@/lib/http";
import { LedgerError } from "@/lib/ledger";
import { isProvider } from "@/lib/accounting/providers";
import { disconnect, linkStatus, saveApp, saveSettings } from "@/lib/accounting/sync";
import { write } from "@/lib/store";

type Ctx = { params: Promise<{ provider: string }> };

async function provider(ctx: Ctx) {
  const { provider: p } = await ctx.params;
  if (!isProvider(p)) throw new LedgerError("Unknown accounting system.", 404);
  return p;
}

/** Save the merchant's own app keys ({ app }) and/or sync settings ({ settings }). */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const p = await provider(ctx);
  const b = await body<{ app?: Record<string, unknown>; settings?: Record<string, unknown> }>(req);
  return json(
    await write((db) => {
      if (b.app) saveApp(db, m, p, b.app);
      if (b.settings) saveSettings(db, m, p, b.settings);
      return linkStatus(db, m, p);
    }),
  );
});

/** Disconnect (and revoke access); with ?keys=1 also forget the app keys. */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const m = await requireMerchant();
  const p = await provider(ctx);
  await disconnect(m, p, new URL(req.url).searchParams.get("keys") === "1");
  return json({ ok: true });
});
