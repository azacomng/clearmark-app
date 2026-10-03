"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { memoText, shortHex, txUrl } from "@/lib/arc";
import { api, date, useApi, when } from "@/lib/client";
import { fmt, toUnits } from "@/lib/money";
import type { PublicInvoice } from "@/lib/service";
import { connect, friendlyError, hasWallet, sendWithMemo, usdcBalance, waitForTx } from "@/lib/wallet";

function countdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

type Step = "idle" | "connecting" | "checking" | "signing" | "confirming" | "done";

export function Checkout({ id }: { id: string }) {
  const { data: inv, error, reload } = useApi<PublicInvoice>(`/api/pay/${id}`, 5000);
  const [mode, setMode] = useState<"full" | "part">("full");
  const [part, setPart] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [settleMs, setSettleMs] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  // Smart Terms countdown: tick once a second while a discount window is open.
  const deadline = inv?.earlyDeadline && inv.state.priceKind === "early" ? Date.parse(inv.earlyDeadline) : null;
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);

  useEffect(() => {
    if (inv && !part) setPart(fmt(BigInt(inv.state.balance) / 2n || inv.state.balance, { min: 2 }).replace(/,/g, ""));
  }, [inv, part]);

  if (error) return <div className="co"><div className="co-body"><h2>Payment link not found</h2><p className="muted">{error}</p></div></div>;
  if (!inv) return <div className="co"><div className="co-body muted">Loading…</div></div>;

  const left = deadline ? deadline - clock : null;
  // In the last minute of a discount window, ask for the standard price: a payment that settles
  // after the deadline is judged at the standard price, and we never want a payer caught short.
  const closing = left !== null && left < 60_000;
  const balance = closing ? BigInt(inv.amount) - BigInt(inv.state.counted) : BigInt(inv.state.balance);
  const settled = balance === 0n && inv.state.status !== "open";
  let amount: bigint | null = balance;
  let amountErr: string | null = null;
  if (mode === "part") {
    try {
      amount = toUnits(part || "0");
      if (amount <= 0n) amountErr = "Enter an amount.";
      else if (amount > balance) amountErr = `That's more than the ${fmt(balance)} USDC due.`;
    } catch (e) {
      amount = null;
      amountErr = (e as Error).message;
    }
  }
  const max = inv.checkout.maxAmount ? BigInt(inv.checkout.maxAmount) : null;
  const limitBlocked = !!max && amount !== null && amount > max;
  const busy = step !== "idle" && step !== "done";

  async function pay() {
    if (!inv || amount === null) return;
    setErr(null);
    try {
      if (!hasWallet()) throw new Error("No wallet found. Open this link in a browser with MetaMask or Rabby.");
      setStep("connecting");
      const account = await connect();
      setStep("checking");
      const check = await api<PublicInvoice>(`/api/pay/${inv.id}?amount=${fmt(amount, { min: 0 }).replace(/,/g, "")}&from=${account}`);
      if (!check.checkout.ok) throw new Error(check.checkout.reason ?? "This payment is outside the merchant's limits.");
      const bal = await usdcBalance(account).catch(() => null);
      if (bal !== null && bal < amount) throw new Error(`This wallet has ${fmt(bal)} USDC. Get testnet USDC at faucet.circle.com.`);
      setStep("signing");
      const hash = await sendWithMemo(account, inv.merchant.address, amount, inv.memoId, memoText({ inv: inv.number, pay: mode }));
      setTx(hash);
      setStep("confirming");
      const t0 = performance.now();
      await waitForTx(hash);
      const settleMs = Math.round(performance.now() - t0);
      setSettleMs(settleMs);
      const res = await api<{ receipts: string[] }>(`/api/pay/${inv.id}/confirm`, { method: "POST", json: { txHash: hash, settleMs } });
      setReceipt(res.receipts[0] ?? null);
      setStep("done");
      reload();
    } catch (e) {
      setErr(friendlyError(e));
      setStep("idle");
    }
  }

  async function simulate(amt: string, extra: Record<string, unknown> = {}) {
    setErr(null);
    try {
      const r = await api<{ receipt: string | null }>("/api/demo/pay", { method: "POST", json: { invoiceId: inv!.id, amount: amt, ...extra } });
      setReceipt(r.receipt);
      setTx(null);
      setStep("done");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const label = {
    idle: amount !== null ? `Pay ${fmt(amount)} USDC` : "Pay",
    connecting: "Connecting wallet…",
    checking: "Checking limits…",
    signing: "Confirm in your wallet…",
    confirming: "Settling on Arc…",
    done: "Paid",
  }[step];

  return (
    <div className="co">
      <div className="co-top">
        <div className="logo">{inv.merchant.name.slice(0, 1).toUpperCase()}</div>
        <div style={{ minWidth: 0 }}>
          <b>{inv.merchant.name}</b>
          <span className="mono">{shortHex(inv.merchant.address)}</span>
        </div>
        <span className="chip testnet" style={{ marginLeft: "auto" }}>Testnet</span>
      </div>
      <div className="co-body">
        {step === "done" ? (
          <div className="done">
            <div className="okcheck" />
            <h2>Payment verified</h2>
            {settleMs ? <div className="settled" style={{ margin: 0 }}><span className="settled-dot" />Settled in {(settleMs / 1000).toFixed(2)}s · final</div> : null}
            <p className="muted">
              {inv.state.label === "PAID" || inv.state.status === "paid" ? `${inv.number} is paid.` : `${inv.number}: ${inv.state.label}.`} Your receipt is ready.
            </p>
            {tx ? <a className="mono" style={{ fontSize: 12 }} href={txUrl(tx)} target="_blank" rel="noreferrer">tx {shortHex(tx)}</a> : null}
            {receipt ? <Link className="btn primary" href={receipt}>View receipt</Link> : null}
            {balance > 0n ? <button className="btn sm" onClick={() => setStep("idle")}>Pay the remaining {fmt(balance)}</button> : null}
          </div>
        ) : inv.voided ? (
          <div className="done"><h2>This invoice was cancelled</h2><p className="muted">Contact {inv.merchant.name} for a new link.</p></div>
        ) : settled ? (
          <div className="done">
            <div className="okcheck" />
            <h2>Already paid</h2>
            <p className="muted">{inv.number} is {inv.state.label.toLowerCase()}. There's nothing left to pay, so you won't be charged twice.</p>
          </div>
        ) : (
          <>
            <div className="co-amt">
              <b>{fmt(mode === "full" ? balance : amount ?? 0n)}</b>
              <span>USDC · {inv.number} · due {date(inv.dueDate)}</span>
            </div>
            {inv.state.priceKind === "early" && !closing && left !== null ? (
              <div className="terms-live">
                <span>
                  Pay now and save <b>{fmt(BigInt(inv.amount) - BigInt(inv.state.price))} USDC</b>: the early-pay price is <b>{fmt(inv.state.price)}</b> instead of {fmt(inv.amount)}.
                </span>
                <span className="count">Discount ends in {countdown(left)}</span>
              </div>
            ) : inv.state.priceKind === "late" ? (
              <div className="terms-live late">
                <span>
                  This invoice is past its due date, so the late fee stated on it applies: <b>{fmt(inv.state.price)} USDC</b> instead of {fmt(inv.amount)}.
                </span>
              </div>
            ) : null}
            <div className="lines">
              <div>{inv.title} <b>{fmt(inv.amount)}</b></div>
              {inv.termsLine ? <div>Terms <b style={{ fontWeight: 400 }}>{inv.termsLine}</b></div> : null}
              {BigInt(inv.state.received) > 0n ? <div>Already paid <b>−{fmt(inv.state.received)}</b></div> : null}
              <div>Billed to <b>{inv.customerName}</b></div>
              <div>Settles to <b className="mono">{shortHex(inv.merchant.address)}</b></div>
              <div>Network <b>Arc testnet · gas paid in USDC</b></div>
            </div>
            {inv.allowSplit ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="seg" role="group" aria-label="How much to pay">
                  <button aria-pressed={mode === "full"} onClick={() => setMode("full")}>Pay in full</button>
                  <button aria-pressed={mode === "part"} onClick={() => setMode("part")}>Pay part</button>
                </div>
                {mode === "part" ? (
                  <label className="field">
                    <span>Amount to pay now (USDC)</span>
                    <input inputMode="decimal" className="mono" value={part} onChange={(e) => setPart(e.target.value)} />
                    {amountErr ? <small style={{ color: "var(--warn)" }}>{amountErr}</small> : <small>The rest stays open on this link.</small>}
                  </label>
                ) : null}
              </div>
            ) : null}
            {!inv.checkout.ok && inv.checkout.maxAmount === "0" ? (
              <p className="notice warn">{inv.checkout.reason}</p>
            ) : limitBlocked ? (
              <p className="notice warn">
                This is above the merchant's limit for one payment. You can pay up to {fmt(max!)} USDC now
                {inv.allowSplit ? " using Pay part." : "."}
              </p>
            ) : null}
            {err ? <p className="notice bad" role="alert">{err}</p> : null}
            <button className="paybtn" onClick={pay} disabled={busy || amount === null || !!amountErr || limitBlocked || inv.checkout.maxAmount === "0"}>
              {busy ? <span className="spinner" /> : null}
              {label}
            </button>
            <p className="co-fine">
              Funds go directly to {inv.merchant.name}. Clearmark never holds them. Your payment carries this invoice's fingerprint, so it's matched the moment it lands.
            </p>
            <p className="co-fine" style={{ marginTop: -4 }}>
              <Link href="/" className="madewith" style={{ display: "inline-block" }}>Invoice with <b>Clearmark</b></Link>
            </p>
          </>
        )}
        {inv.payments.length > 0 ? (
          <div className="lines" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
            {inv.payments.map((p) => (
              <div key={p.key}>
                <span>{when(p.timestamp)} · {p.held ? "under review" : p.clsLabel ?? "received"}</span>
                <b><Link href={`/r/p/${p.key}`}>{fmt(p.amount)} receipt</Link></b>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {inv.demo && !inv.voided ? (
        <div className="demo-box">
          <p>Demo · simulate the customer paying (merchant only)</p>
          <div className="demo-grid">
            <button onClick={() => simulate(fmt(balance || BigInt(inv.amount), { min: 2 }).replace(/,/g, ""))}>Exact<span>{fmt(balance || BigInt(inv.amount))}</span></button>
            <button onClick={() => simulate(((Number(inv.amount) * 0.8) / 1e6).toFixed(2))}>Short payment<span>80%</span></button>
            <button onClick={() => simulate(((Number(inv.amount) * 1.2) / 1e6).toFixed(2))}>Too much<span>120%</span></button>
            <button onClick={() => simulate((Number(inv.amount) / 2e6).toFixed(2), { intent: "part" })}>Half, as a part<span>split</span></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
