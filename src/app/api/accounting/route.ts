import { handle, json, requestOrigin, requireMerchant } from "@/lib/http";
import { linkStatus } from "@/lib/accounting/sync";
import { read } from "@/lib/store";

/** Both connections' status for the settings page, with the redirect URI each app must register. */
export const GET = handle(async (req: Request) => {
  const m = await requireMerchant();
  const db = await read();
  const origin = requestOrigin(req);
  return json({
    xero: { ...linkStatus(db, m, "xero"), redirectUri: `${origin}/api/accounting/xero/callback` },
    quickbooks: { ...linkStatus(db, m, "quickbooks"), redirectUri: `${origin}/api/accounting/quickbooks/callback` },
  });
});
