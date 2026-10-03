"use client";

import { useState } from "react";
import { memoText, shortHex } from "@/lib/arc";
import { api } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { Hex, Refund } from "@/lib/types";
import { connect, friendlyError, sendWithMemo, signText, waitForTx } from "@/lib/wallet";
import { useConnectWallet } from "./WalletProvider";

/** A refund that hasn't been sent yet: approve it (if over the limit), send it from the wallet, or cancel. */
export function RefundCard({ refund: r, merchant, onDone }: { refund: Refund; merchant: string; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const connectWallet = useConnectWallet();
  const post = (path: string, json: unknown) => api(path, { method: "POST", json });

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

  async function merchantAccount() {
    await connectWallet();
    const account = await connect();
    if (account !== merchant.toLowerCase()) throw new Error(`Switch your wallet to ${shortHex(merchant)}, the merchant wallet.`);
    return account;
  }

  const approve = async () => {
    const { approvalMessage } = await api<{ approvalMessage: string }>(`/api/refunds/${r.id}`);
    const account = await merchantAccount();
    await post(`/api/refunds/${r.id}`, { action: "approve", signature: await signText(account, approvalMessage) });
  };

  const send = async () => {
    if (r.source === "demo") return post("/api/demo/refund", { refundId: r.id });
    const account = await merchantAccount();
    const hash = await sendWithMemo(account, r.to as Hex, BigInt(r.amount), r.memoId, memoText({ refund: r.id }), r.token ?? "USDC");
    await waitForTx(hash);
    return post(`/api/refunds/${r.id}`, { action: "confirm", txHash: hash });
  };

  const cancel = () => post(`/api/refunds/${r.id}`, { action: "cancel" });
  const needsApproval = r.status === "pending_approval";

  return (
    <div className="suggest">
      <b>
        Refund {fmt(r.amount)} {r.token ?? "USDC"} to {shortHex(r.to)}
      </b>
      <span className="muted" style={{ fontSize: 13 }}>
        {needsApproval
          ? "This is above your refund approval limit, so approve it with a wallet signature first."
          : r.source === "demo"
            ? "This is for a simulated payment, so the refund is simulated too."
            : "It's sent from your wallet with a memo that links it to the original payment."}
      </span>
      <div className="row">
        {needsApproval ? (
          <button className="btn primary sm" disabled={!!busy} onClick={() => run("ap", approve)}>
            {busy === "ap" ? <span className="spinner" /> : null} Approve refund
          </button>
        ) : (
          <button className="btn primary sm" disabled={!!busy} onClick={() => run("sd", send)}>
            {busy === "sd" ? <span className="spinner" /> : null} {r.source === "demo" ? "Simulate refund" : "Send refund"}
          </button>
        )}
        <button className="btn sm" disabled={!!busy} onClick={() => run("cx", cancel)}>
          Cancel
        </button>
      </div>
      {err ? <p className="notice bad">{err}</p> : null}
    </div>
  );
}
