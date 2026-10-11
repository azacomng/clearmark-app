"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { connect, ensureArc, friendlyError, signText } from "@/lib/wallet";
import { useConnectWallet } from "./WalletProvider";

export function SignIn({ label = "Sign in with wallet", primary = true }: { label?: string; primary?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connectWallet = useConnectWallet();

  async function go() {
    setErr(null);
    setBusy(true);
    try {
      await connectWallet();
      const address = await connect();
      await ensureArc().catch(() => {}); // signing works on any network; payments switch later
      const { nonce, message } = await api<{ nonce: string; message: string }>("/api/auth/nonce", { method: "POST", json: { address } });
      const signature = await signText(address, message);
      await api("/api/auth/verify", { method: "POST", json: { address, nonce, signature } });
      router.push("/app");
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <button className={`btn ${primary ? "primary" : ""}`} onClick={go} disabled={busy}>
        {busy ? <span className="spinner" /> : null}
        {busy ? "Check your wallet…" : label}
      </button>
      {err ? <p className="notice bad" role="alert">{err}</p> : null}
    </div>
  );
}
