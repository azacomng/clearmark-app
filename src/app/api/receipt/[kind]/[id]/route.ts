import { handle, json } from "@/lib/http";
import { receiptData } from "@/lib/receipts";
import { read } from "@/lib/store";

type Ctx = { params: Promise<{ kind: string; id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { kind, id } = await ctx.params;
  return json(receiptData(await read(), kind, id));
});
