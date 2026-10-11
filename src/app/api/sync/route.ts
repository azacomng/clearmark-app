import { after } from "next/server";
import { handle, json, requestOrigin, requireMerchant } from "@/lib/http";
import { syncMerchant } from "@/lib/service";
import { autoSyncAccounting } from "@/lib/accounting/sync";

export const maxDuration = 120;

export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  // Connected accounting systems catch up after the response, so the dashboard isn't kept waiting.
  const origin = requestOrigin(req);
  after(() => autoSyncAccounting(m, origin));
  return json(await syncMerchant(m));
});
