"use client";

import { useState } from "react";
import { memoText, shortHex } from "@/lib/arc";
import { api } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { Hex, Refund } from "@/lib/types";
import { connect, friendlyError, sendWithMemo, signText, waitForTx } from "@/lib/wallet";
import { useConfirm, type ConfirmOptions } from "./Confirm";
import { useConnectWallet } from "./WalletProvider";

/** Approve and send refunds from the merchant wallet. Shared by the refund card and the invoice timeline. */
export function useRefundActions(merchant: string) {
  const connectWallet = useConnectWallet();
  const post = (path: string, json: unknown) => api(path, { method: "POST", json });

  async function merchantAccount() {
    await connectWallet();
    const account = await connect();
    if (account !== merchant.toLowerCase()) throw new Error(`Switch your wallet to ${shortHex(merchant)}, the merchant wallet.`);
    return account;
  }

  const approve = async (r: Refund) => {
    const { approvalMessage } = await api<{ approvalMessage: string }>(`/api/refunds/${r.id}`);
    const account = await merchantAccount();
    await post(`/api/refunds/${r.id}`, { action: "approve", signature: await signText(account, approvalMessage) });
  };

  const send = async (r: Refund) => {
    if (r.source === "demo") return post("/api/demo/refund", { refundId: r.id });
    const account = await merchantAccount();
    const hash = await sendWithMemo(account, r.to as Hex, BigInt(r.amount), r.memoId, memoText({ refund: r.id }), r.token ?? "USDC");
    await waitForTx(hash);
    return post(`/api/refunds/${r.id}`, { action: "confirm", txHash: hash });
  };

  return { approve, send };
}

/** The confirm step shown before any refund goes out. Refunds can't be pulled back once sent. */
export function refundConfirm(r: Pick<Refund, "amount" | "to" | "source" | "token">): ConfirmOptions {
  const amt = `${fmt(r.amount)} ${r.token ?? "USDC"}`;
  return {
    title: `Refund ${amt}?`,
    body:
      r.source === "demo" ? (
        <>This payment was simulated, so the refund to {shortHex(r.to)} is simulated too. Once recorded it can&apos;t be undone.</>
      ) : (
        <>
          This sends <b>{amt}</b> from your wallet to <span className="mono">{shortHex(r.to)}</span>, the wallet that paid. Money that has been
          sent can&apos;t be pulled back, so check the amount first.
        </>
      ),
    confirmLabel: `Refund ${amt}`,
  };
}

/** A refund that hasn't been sent yet: approve it (if over the limit), send it from the wallet, or cancel. */
export function RefundCard({ refund: r, merchant, onDone }: { refund: Refund; merchant: string; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { approve, send } = useRefundActions(merchant);
  const { ask, dialog } = useConfirm();

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

  const confirmAndSend = async () => {
    if ((await ask(refundConfirm(r))) === null) return;
    await run("sd", () => send(r));
  };
  const cancel = () => api(`/api/refunds/${r.id}`, { method: "POST", json: { action: "cancel" } });
  const needsApproval = r.status === "pending_approval";

  return (
    <div className="suggest">
      {dialog}
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
          <button className="btn primary sm" disabled={!!busy} onClick={() => run("ap", () => approve(r))}>
            {busy === "ap" ? <span className="spinner" /> : null} Approve refund
          </button>
        ) : (
          <button className="btn primary sm" disabled={!!busy} onClick={confirmAndSend}>
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
