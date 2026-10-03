import { body, handle, json, requireMerchant } from "@/lib/http";
import { setMerchantName, updateLimits } from "@/lib/ledger";
import { merchantPayments } from "@/lib/ledger";
import { receivedToday } from "@/lib/limits";
import { read, write } from "@/lib/store";
import type { Limits } from "@/lib/types";

export const GET = handle(async () => {
  const m = await requireMerchant();
  const db = await read();
  const now = new Date().toISOString();
  return json({ limits: db.merchants[m].limits, name: db.merchants[m].name, receivedToday: receivedToday(merchantPayments(db, m), now).toString() });
});

export const PUT = handle(async (req: Request) => {
  const m = await requireMerchant();
  const b = await body<{ limits?: Record<keyof Limits, string | null>; name?: string }>(req);
  return json(
    await write((db) => {
      if (b.name !== undefined) setMerchantName(db, m, b.name);
      if (b.limits) updateLimits(db, m, b.limits);
      return { limits: db.merchants[m].limits, name: db.merchants[m].name };
    }),
  );
});
