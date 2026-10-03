import { sessionAddress } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { read } from "@/lib/store";

export const GET = handle(async () => {
  const a = await sessionAddress();
  if (!a) return json({ address: null });
  const db = await read();
  return json({ address: a, merchant: db.merchants[a] ?? null });
});
