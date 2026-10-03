"use client";

import { useState } from "react";
import type { Log } from "viem";
import { extractTransfers } from "@/lib/arc";
import type { Hex } from "@/lib/types";
import { browserClient } from "@/lib/wallet";

/** Re-check the receipt against Arc directly from the browser, without trusting Clearmark's server. */
export function ReVerify(p: { kind: string; source: string; txHash: Hex; from: Hex; to: Hex; amount: string; memoId: Hex | null; token?: string }) {
  const [state, setState] = useState<{ kind: "ok" | "bad" | "busy"; text: string } | null>(null);

  async function run() {
    if (p.source === "demo") {
      setState({ kind: "bad", text: "This is a simulated demo payment, so there is nothing onchain to check." });
      return;
    }
    setState({ kind: "busy", text: "Reading the transaction from Arc…" });
    try {
      const rc = await browserClient.getTransactionReceipt({ hash: p.txHash });
      if (rc.status !== "success") throw new Error("The transaction reverted.");
      const ts = (await browserClient.getBlock({ blockNumber: rc.blockNumber })).timestamp;
      const match = extractTransfers(rc.logs as Log[], p.txHash).find(
        (t) => t.from === p.from.toLowerCase() && t.to === p.to.toLowerCase() && t.amount === BigInt(p.amount) && t.token === (p.token ?? "USDC"),
      );
      if (!match) throw new Error(`No matching ${p.token ?? "USDC"} transfer in that transaction.`);
      if (p.memoId && match.memoId?.toLowerCase() !== p.memoId.toLowerCase()) throw new Error("The memo onchain doesn't match this receipt.");
      setState({ kind: "ok", text: `Verified on Arc: block ${rc.blockNumber.toLocaleString()}, ${new Date(Number(ts) * 1000).toUTCString()}.` });
    } catch (e) {
      setState({ kind: "bad", text: `Could not verify: ${(e as Error).message.split("\n")[0]}` });
    }
  }

  return (
    <>
      <button className="btn primary sm" onClick={run} disabled={state?.kind === "busy"}>
        {state?.kind === "busy" ? <span className="spinner" /> : null} Re-verify on Arc
      </button>
      {state && state.kind !== "busy" ? <p className={`notice ${state.kind}`} style={{ flexBasis: "100%" }}>{state.text}</p> : null}
    </>
  );
}
