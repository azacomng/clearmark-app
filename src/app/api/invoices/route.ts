import { body, handle, json, requireMerchant } from "@/lib/http";
import { createInvoice, type NewInvoice } from "@/lib/ledger";
import { dashboard, invoiceView } from "@/lib/service";
import { read, write } from "@/lib/store";

export const GET = handle(async () => {
  const m = await requireMerchant();
  return json(dashboard(await read(), m));
});

export const POST = handle(async (req: Request) => {
  const m = await requireMerchant();
  const input = await body<NewInvoice>(req);
  const inv = await write((db) => invoiceView(db, createInvoice(db, m, input, new Date())));
  return json(inv, 201);
});
