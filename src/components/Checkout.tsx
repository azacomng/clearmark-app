"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { memoText, shortHex, txUrl, type Token } from "@/lib/arc";
import { bridgeToArc, estimateBridge, SOURCE_CHAINS, type SourceChain } from "@/lib/circle";
import { toTokenUnits } from "@/lib/fx";
import { api, date, useApi, when } from "@/lib/client";
import { fmt, toUnits } from "@/lib/money";
import type { PublicInvoice } from "@/lib/service";
import { connect, contractAccepts, ensureArcTestnet, friendlyError, hasWallet, payViaContract, sendWithMemo, tokenBalance, waitForTx } from "@/lib/wallet";
import { useConnectWallet } from "./WalletProvider";

interface QuoteView {
  id: string;
  rate: string;
  usdc: string;
  eur: string;
  expiresAt: string;
  line: string;
}

/** A little USDC on top of a bridge, so the payer still has Arc gas (paid in USDC) after the mint. */
const GAS_BUFFER = 50_000n;

function countdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

type Step = "idle" | "connecting" | "checking" | "quoting" | "bridging" | "signing" | "confirming" | "done";

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
  const [payToken, setPayToken] = useState<Token | null>(null);
  const [from, setFrom] = useState<"arc" | SourceChain>("arc");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [bridgeFee, setBridgeFee] = useState<bigint | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  // Smart Terms countdown: tick once a second while a discount window is open.
  const deadline = inv?.earlyDeadline && inv.state.priceKind === "early" ? Date.parse(inv.earlyDeadline) : null;
  const quoteEnds = quote ? Date.parse(quote.expiresAt) : null;
  useEffect(() => {
    if (!deadline && !quoteEnds) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline, quoteEnds]);

  // A EUR invoice paid in USDC shows a live quote, refreshed when it runs out.
  const wantsQuote = !!inv && inv.currency === "EUR" && (payToken ?? inv.token) === "USDC" && BigInt(inv.state.balance) > 0n && !inv.voided;
  const quoteStale = !quote || Date.parse(quote.expiresAt) - clock < 30_000;
  useEffect(() => {
    if (!wantsQuote || !quoteStale || !inv) return;
    let live = true;
    api<QuoteView>(`/api/pay/${inv.id}/quote`, { method: "POST", json: {} })
      .then((q) => live && setQuote(q))
      .catch((e) => live && setErr(friendlyError(e)));
    return () => {
      live = false;
    };
  }, [wantsQuote, quoteStale, inv]);
  const connectWallet = useConnectWallet();

  useEffect(() => {
    if (inv && !part) setPart(fmt(BigInt(inv.state.balance) / 2n || inv.state.balance, { min: 2 }).replace(/,/g, ""));
  }, [inv, part]);

  if (error) return <div className="co"><div className="co-body"><h2>Payment link not found</h2><p className="muted">{error}</p></div></div>;
  if (!inv) return <div className="co"><div className="co-body muted">Loading…</div></div>;

  const unit = inv.unit;
  const token: Token = from !== "arc" ? "USDC" : payToken ?? inv.token;
  const fx = inv.currency === "EUR" && token === "USDC";
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
      else if (amount > balance) amountErr = `That's more than the ${fmt(balance)} ${unit} due.`;
    } catch (e) {
      amount = null;
      amountErr = (e as Error).message;
    }
  }
  const max = inv.checkout.maxAmount ? BigInt(inv.checkout.maxAmount) : null;
  const limitBlocked = !!max && amount !== null && amount > max;
  const busy = step !== "idle" && step !== "done";
  /** What leaves the payer's wallet, in `token` units. */
  const sendAmount = (q: QuoteView | null, a: bigint) => (fx ? (q ? toTokenUnits(a, BigInt(q.rate)) : null) : a);
  const toSend = amount === null ? null : sendAmount(quote, amount);

  async function estimate(chain: SourceChain) {
    setBridgeFee(null);
    if (!hasWallet() || toSend === null) return;
    try {
      const account = await connect();
      setBridgeFee(await estimateBridge(chain, account, toSend + GAS_BUFFER));
    } catch {
      setBridgeFee(null);
    }
  }

  async function pay() {
    if (!inv || amount === null) return;
    setErr(null);
    try {
      setStep("connecting");
      await connectWallet();
      const account = await connect();
      setStep("checking");
      const check = await api<PublicInvoice>(`/api/pay/${inv.id}?amount=${fmt(amount, { min: 0 }).replace(/,/g, "")}&from=${account}`);
      if (!check.checkout.ok) throw new Error(check.checkout.reason ?? "This payment is outside the merchant's limits.");
      let q = quote;
      if (fx) {
        setStep("quoting");
        q = await api<QuoteView>(`/api/pay/${inv.id}/quote`, { method: "POST", json: {} });
        setQuote(q);
      }
      const send = sendAmount(q, amount)!;
      if (from !== "arc") {
        // Bridge first, to the payer's own Arc wallet: a memo can't travel across chains, so the
        // fingerprinted payment is made on Arc once the USDC arrives.
        const have = await tokenBalance(account, "USDC").catch(() => 0n);
        if (have < send + GAS_BUFFER) {
          setStep("bridging");
          const need = send + GAS_BUFFER - have;
          const fee = await estimateBridge(from, account, need).catch(() => 0n);
          await bridgeToArc(from, account, need + fee, setStage);
          setStage("Waiting for the USDC to land on Arc…");
          await ensureArcTestnet();
          for (let i = 0; i < 30 && (await tokenBalance(account, "USDC").catch(() => 0n)) < send; i++) await new Promise((r) => setTimeout(r, 2000));
          setStage(null);
        }
      }
      const bal = await tokenBalance(account, token).catch(() => null);
      if (bal !== null && bal < send) throw new Error(`This wallet has ${fmt(bal)} ${token} on Arc. Get testnet ${token} at faucet.circle.com.`);
      setStep("signing");
      const fields: Record<string, string> = { inv: inv.number, pay: mode };
      if (fx && q) fields.q = q.id;
      if (from !== "arc") fields.via = from;
      // Plain full payments on Arc go through the ClearmarkPay contract. Part payments, rate-quoted and
      // bridged payments keep the Memo route, because their memo carries the intent, quote or source.
      const viaContract = mode === "full" && !fx && from === "arc" && (await contractAccepts(token));
      const hash = viaContract
        ? await payViaContract(account, inv.merchant.address, send, inv.memoId, token, setStage)
        : await sendWithMemo(account, inv.merchant.address, send, inv.memoId, memoText(fields), token);
      setStage(null);
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
      setStage(null);
    }
  }

  async function simulate(amt: string, extra: Record<string, unknown> = {}) {
    setErr(null);
    try {
      const r = await api<{ receipt: string | null }>("/api/demo/pay", { method: "POST", json: { invoiceId: inv!.id, amount: amt, token: inv!.token, ...extra } });
      setReceipt(r.receipt);
      setTx(null);
      setStep("done");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const label = {
    idle: toSend !== null ? `Pay ${fmt(toSend)} ${token}${from !== "arc" ? ` from ${SOURCE_CHAINS.find((c) => c.id === from)?.label}` : ""}` : "Pay",
    connecting: "Connecting wallet…",
    checking: "Checking limits…",
    quoting: "Locking the exchange rate…",
    bridging: stage ?? "Bridging USDC to Arc…",
    signing: stage ?? "Confirm in your wallet…",
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
              <span>{unit} · {inv.number} · due {date(inv.dueDate)}</span>
            </div>
            {inv.state.priceKind === "early" && !closing && left !== null ? (
              <div className="terms-live">
                <span>
                  Pay now and save <b>{fmt(BigInt(inv.amount) - BigInt(inv.state.price))} {unit}</b>: the early-pay price is <b>{fmt(inv.state.price)}</b> instead of {fmt(inv.amount)}.
                </span>
                <span className="count">Discount ends in {countdown(left)}</span>
              </div>
            ) : inv.state.priceKind === "late" ? (
              <div className="terms-live late">
                <span>
                  This invoice is past its due date, so the late fee stated on it applies: <b>{fmt(inv.state.price)} {unit}</b> instead of {fmt(inv.amount)}.
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
            <div className="stack" style={{ gap: 8 }}>
              {inv.currency === "EUR" && from === "arc" ? (
                <div className="seg" role="group" aria-label="Pay with">
                  <button aria-pressed={token === "EURC"} onClick={() => setPayToken("EURC")}>Pay in EURC</button>
                  <button aria-pressed={token === "USDC"} onClick={() => setPayToken("USDC")}>Pay in USDC</button>
                </div>
              ) : null}
              {fx ? (
                <div className="terms-live fx">
                  {quote && toSend !== null ? (
                    <>
                      <span>
                        You pay <b>{fmt(toSend)} USDC</b> at {quote.line}. The rate is locked into your payment, so {fmt(amount ?? 0n)} EUR is what counts.
                      </span>
                      <span className="count">Rate held for {countdown(Date.parse(quote.expiresAt) - clock)}</span>
                    </>
                  ) : (
                    <span>Getting today's euro rate…</span>
                  )}
                </div>
              ) : null}
              <label className="field">
                <span>Pay from</span>
                <select
                  value={from}
                  onChange={(e) => {
                    const v = e.target.value as "arc" | SourceChain;
                    setFrom(v);
                    if (v !== "arc") estimate(v);
                  }}
                >
                  <option value="arc">My wallet on Arc</option>
                  {SOURCE_CHAINS.map((c) => (
                    <option key={c.id} value={c.id}>USDC on {c.label}</option>
                  ))}
                </select>
                {from !== "arc" ? (
                  <small>
                    Circle's bridge (CCTP) moves your USDC to your own wallet on Arc, then you pay from there with this invoice's fingerprint. Two wallet approvals, no Arc gas needed for the bridge
                    {bridgeFee !== null ? `. Bridge fees about ${fmt(bridgeFee)} USDC` : ""}.
                  </small>
                ) : null}
              </label>
            </div>
            {inv.allowSplit ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="seg" role="group" aria-label="How much to pay">
                  <button aria-pressed={mode === "full"} onClick={() => setMode("full")}>Pay in full</button>
                  <button aria-pressed={mode === "part"} onClick={() => setMode("part")}>Pay part</button>
                </div>
                {mode === "part" ? (
                  <label className="field">
                    <span>Amount to pay now ({unit})</span>
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
                This is above the merchant's limit for one payment. You can pay up to {fmt(max!)} {unit} now
                {inv.allowSplit ? " using Pay part." : "."}
              </p>
            ) : null}
            {err ? <p className="notice bad" role="alert">{err}</p> : null}
            <button className="paybtn" onClick={pay} disabled={busy || amount === null || toSend === null || !!amountErr || limitBlocked || inv.checkout.maxAmount === "0"}>
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
                <b><Link href={`/r/p/${p.key}`}>{fmt(p.amount)} {p.token} receipt</Link></b>
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
            {inv.currency === "EUR" && toSend !== null ? (
              <button onClick={() => simulate("quote", { token: "USDC" })}>Pay in USDC<span>quoted</span></button>
            ) : null}
            <button onClick={() => (inv.currency === "EUR" ? simulate("quote", { token: "USDC", via: "Base_Sepolia" }) : simulate(fmt(balance || BigInt(inv.amount), { min: 2 }).replace(/,/g, ""), { via: "Base_Sepolia" }))}>From Base<span>bridged</span></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
