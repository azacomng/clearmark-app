import { handle, json, requireMerchant } from "@/lib/http";
import { syncMerchant } from "@/lib/service";

export const POST = handle(async () => {
  const m = await requireMerchant();
  return json(await syncMerchant(m));
});
