"use client";

import { useState } from "react";
import { shortHex, txUrl } from "@/lib/arc";
import { api } from "@/lib/client";
import { swapFeeBps, swapUsdcToEurc } from "@/lib/circle";
import { fmt } from "@/lib/money";
import type { InvoiceView } from "@/lib/service";
import { connect, friendlyError, waitForTx } from "@/lib/wallet";

/** EUR invoices paid in USDC: convert the USDC to EURC with Circle's Swap Kit, from the merchant's wallet. */
export function ConvertCard({ inv, onDone }: { inv: InvoiceView; onDone: () => void }) {
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const left = BigInt(inv.unconvertedUsdc);
  const done = inv.conversions ?? [];
  if (inv.currency !== "EUR" || (left === 0n && done.length === 0)) return null;
  const fee = swapFeeBps();

  async function convert() {
    setErr(null);
    try {
      setStep("Connecting wallet…");
      const account = await connect();
      if (account !== inv.merchant.toLowerCase()) throw new Error(`Switch your wallet to ${shortHex(inv.merchant)}, the merchant wallet.`);
      const { txHash } = await swapUsdcToEurc(left, setStep);
      setStep("Settling on Arc…");
      await waitForTx(txHash);
      await api(`/api/invoices/${inv.id}`, { method: "POST", json: { action: "converted", txHash } });
      onDone();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="suggest" style={{ borderStyle: "solid" }}>
      {left > 0n ? (
        <>
          <b>Convert {fmt(left)} USDC to EURC</b>
          <span className="muted" style={{ fontSize: 13 }}>
            This invoice is in euros and was paid in USDC. Swap it to EURC on Arc with Circle's Swap Kit, straight from your wallet. You see the quote before you sign
            {fee ? `, and it includes a ${fee / 100}% Clearmark fee` : ""}.
          </span>
          <div className="row">
            <button className="btn primary sm" disabled={!!step} onClick={convert}>
              {step ? <span className="spinner" /> : null} {step ?? "Convert to EURC"}
            </button>
          </div>
        </>
      ) : null}
      {done.map((c) => (
        <span key={c.txHash} className="muted mono" style={{ fontSize: 12 }}>
          Converted {fmt(c.amountIn)} USDC to EURC · <a href={txUrl(c.txHash)} target="_blank" rel="noreferrer">tx {shortHex(c.txHash)}</a>
        </span>
      ))}
      {err ? <p className="notice bad">{err}</p> : null}
    </div>
  );
}
