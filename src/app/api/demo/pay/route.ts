import { body, handle, json, requireMerchant } from "@/lib/http";
import { createQuote, invoiceState, LedgerError, recordTransfer } from "@/lib/ledger";
import { currencyOf, needsFx } from "@/lib/fx";
import { eurPerUsdc } from "@/lib/rates";
import { memoText } from "@/lib/arc";
import { toUnits } from "@/lib/money";
import { DEMO, demoTxHash, paymentKey, publicInvoice } from "@/lib/service";
import { write } from "@/lib/store";
import type { Hex } from "@/lib/types";

const DEMO_PAYER = "0x9a1d5e0c2b7f4a3e8d6c1b0a9f8e7d6c5b4ac07b" as Hex;

/**
 * Demo mode only: inject a simulated transfer through the same reconciliation pipeline.
 * Only the invoice's own merchant can simulate payments on it.
 */
export const POST = handle(async (req: Request) => {
  if (!DEMO) throw new LedgerError("Demo mode is off.", 404);
  const merchant = await requireMerchant();
  const b = await body<{ invoiceId: string; amount: string; intent?: "full" | "part"; tagged?: boolean; from?: string; token?: "USDC" | "EURC"; via?: string }>(req);
  const now = new Date();
  const token = b.token === "EURC" ? "EURC" : "USDC";
  const rate = token === "USDC" ? await eurPerUsdc() : null;
  const out = await write((db) => {
    const inv = db.invoices[b.invoiceId];
    if (!inv || inv.merchant !== merchant) throw new LedgerError("Invoice not found", 404);
    // A simulated USDC payment on a EUR invoice takes a quote, exactly like checkout does.
    // amount "quote" pays exactly what the quote asks for.
    let q: string | undefined;
    let amount = b.amount === "quote" ? null : toUnits(b.amount);
    if (needsFx(currencyOf(inv), token) && rate && b.tagged !== false) {
      const due = BigInt(invoiceState(db, inv, now).balance);
      const quote = createQuote(db, inv.id, due > 0n ? due : BigInt(inv.amount), rate.rate, rate.source, now);
      q = quote.id;
      amount ??= BigInt(quote.usdc);
    }
    if (amount === null) throw new LedgerError("No exchange rate is available to quote this payment.");
    const p = recordTransfer(
      db,
      {
        source: "demo",
        txHash: demoTxHash(inv.id),
        logIndex: 0,
        blockNumber: BigInt(Date.now()),
        timestamp: now.toISOString(),
        from: ((b.from as Hex) || DEMO_PAYER).toLowerCase() as Hex,
        to: inv.merchant,
        amount,
        memoId: b.tagged === false ? null : inv.memoId,
        memoData: b.tagged === false ? null : memoText({ inv: inv.number, pay: b.intent ?? "full", ...(q ? { q } : {}), ...(b.via ? { via: b.via } : {}) }),
        token,
      },
      now,
    );
    // Simulated payments get a typical Arc settle time so the receipt stamp looks like the real thing.
    if (p && p.settleMs == null) p.settleMs = 450 + Math.floor(Math.random() * 450);
    return { payment: p, invoice: publicInvoice(db, inv, now) };
  });
  return json({ ...out, receipt: out.payment ? `/r/p/${paymentKey(out.payment)}` : null });
});
