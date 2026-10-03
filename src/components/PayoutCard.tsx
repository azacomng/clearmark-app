"use client";

import Link from "next/link";
import { useState } from "react";
import { shortHex, txUrl } from "@/lib/arc";
import { api } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { InvoiceView } from "@/lib/service";
import type { Payout } from "@/lib/types";
import { connect, friendlyError, sendBatch, waitForTx } from "@/lib/wallet";

/** Payday Splits: preview the shares, then pay every collaborator in one batch from the merchant's wallet. */
export function PayoutCard({ inv, onDone }: { inv: InvoiceView; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const plan = inv.payoutPlan;
  if (!plan || inv.splits.length === 0) return null;
  const payout: Payout | undefined = inv.payouts[0];
  const paid = ["paid", "overpaid", "duplicate"].includes(inv.state.status);
  const lines = payout?.lines ?? plan.lines;
  const total = lines.reduce((t, l) => t + BigInt(l.amount), 0n);
  const keep = BigInt(payout?.base ?? plan.base) - total;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const prepare = () => api("/api/payouts", { method: "POST", json: { invoiceId: inv.id } });
  const send = async () => {
    if (!payout) return;
    if (payout.source === "demo") return api(`/api/payouts/${payout.id}`, { method: "POST", json: { action: "simulate" } });
    const account = await connect();
    if (account !== inv.merchant.toLowerCase()) throw new Error(`Switch your wallet to ${shortHex(inv.merchant)}, the merchant wallet.`);
    const hash = await sendBatch(account, payout.token, payout.lines.map((l) => ({ to: l.address, amount: BigInt(l.amount) })));
    await waitForTx(hash);
    return api(`/api/payouts/${payout.id}`, { method: "POST", json: { action: "confirm", txHash: hash } });
  };
  const cancel = () => payout && api(`/api/payouts/${payout.id}`, { method: "POST", json: { action: "cancel" } });

  const token = payout?.token ?? plan.token;

  return (
    <div className="split-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>Payday Splits</b>
        <span className={`stamp ${payout?.status === "sent" ? "s-paid" : paid ? "s-partial" : "s-open"}`}>
          {payout?.status === "sent" ? "PAID OUT" : paid ? "READY" : "AFTER PAYMENT"}
        </span>
      </div>
      <div className="split-lines">
        {lines.map((l, i) => (
          <div key={l.address}>
            <span>
              {l.label} <em className="mono">{shortHex(l.address)}</em> · {l.bps / 100}%
            </span>
            <b className="mono">
              {payout?.status === "sent" ? <Link href={`/r/s/${payout.id}.${i}`}>{fmt(l.amount)} {token}</Link> : `${fmt(l.amount)} ${token}`}
            </b>
          </div>
        ))}
        <div className="you">
          <span>You keep</span>
          <b className="mono">{fmt(keep > 0n ? keep : 0n)} {token}</b>
        </div>
      </div>
      {!paid ? (
        <span className="muted" style={{ fontSize: 13 }}>Shares are worked out on what the invoice settles for. Once it's paid, you send them all in one transaction.</span>
      ) : payout?.status === "sent" ? (
        <span className="muted" style={{ fontSize: 13 }}>
          Sent in one transaction{payout.source === "demo" ? " (simulated)" : payout.txHash ? <> · <a href={txUrl(payout.txHash)} target="_blank" rel="noreferrer">tx {shortHex(payout.txHash)}</a></> : null}. Each collaborator has a receipt with an invite to their own workspace.
        </span>
      ) : !payout ? (
        <div className="row">
          <button className="btn primary sm" disabled={!!busy} onClick={() => run("prep", prepare)}>
            {busy === "prep" ? <span className="spinner" /> : null} Prepare payout of {fmt(total)} {token}
          </button>
        </div>
      ) : (
        <>
          <span className="muted" style={{ fontSize: 13 }}>
            {payout.source === "demo"
              ? "These shares come from simulated payments, so the payout is simulated too."
              : `One approval sends every share from your wallet through Arc's batch contract. Make sure the wallet holds ${fmt(total)} ${token}.`}
          </span>
          <div className="row">
            <button className="btn primary sm" disabled={!!busy} onClick={() => run("send", send)}>
              {busy === "send" ? <span className="spinner" /> : null} {payout.source === "demo" ? "Simulate payout" : `Pay ${lines.length} collaborator${lines.length === 1 ? "" : "s"}`}
            </button>
            <button className="btn sm" disabled={!!busy} onClick={() => run("cx", async () => cancel())}>Cancel</button>
          </div>
        </>
      )}
      {err ? <p className="notice bad">{err}</p> : null}
    </div>
  );
}
