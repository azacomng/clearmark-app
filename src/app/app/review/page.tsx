"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { shortHex, txUrl } from "@/lib/arc";
import { api, useApi, when } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { reviewItems } from "@/lib/service";
import { useShell } from "@/components/AppShell";
import { useConfirm } from "@/components/Confirm";
import { RefundCard } from "@/components/RefundCard";

type Review = ReturnType<typeof reviewItems>;

export default function ReviewInbox() {
  const { tick, refresh, setReviewCount } = useShell();
  const { data, error, reload } = useApi<Review>("/api/review");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    reload();
  }, [tick, reload]);
  useEffect(() => {
    if (data) setReviewCount(data.count);
  }, [data, setReviewCount]);

  async function act(key: string, json: unknown) {
    setBusy(key);
    setErr(null);
    try {
      await api("/api/review", { method: "POST", json });
      await reload();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="notice bad">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function dismiss(p: Review["unmatched"][number]) {
    const reason = await ask({
      title: `Void this ${fmt(p.amount)} ${p.token} payment?`,
      body: (
        <>
          It leaves this inbox and stays in your history, crossed out. No money moves: to send it back, use Return to sender or a refund instead. A
          void can&apos;t be undone.
        </>
      ),
      confirmLabel: "Void payment",
      danger: true,
      reason: { presets: ["Test payment", "Not a customer payment", "Sent by mistake"], placeholder: "Why is this payment void?" },
    });
    if (reason !== null) await act(p.id, { action: "void", payment: p.key, reason });
  }

  async function removeDemo(p: Review["unmatched"][number]) {
    const ok = await ask({
      title: `Delete this simulated ${fmt(p.amount)} ${p.token} payment?`,
      body: <>It&apos;s removed with its receipt, as if it never arrived. Only simulated payments can be deleted.</>,
      confirmLabel: "Delete payment",
      danger: true,
    });
    if (ok === null) return;
    setBusy(p.id);
    setErr(null);
    try {
      await api("/api/demo/delete", { method: "POST", json: { payment: p.key } });
      await reload();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {dialog}
      <div className="page-h">
        <div>
          <h1>Needs review</h1>
          <p>Only what Clearmark couldn't settle on its own. Everything else was matched automatically.</p>
        </div>
      </div>
      {err ? <p className="notice bad">{err}</p> : null}
      {data.count === 0 ? (
        <div className="card empty">
          <h2>All clear</h2>
          <p>No unmatched, held or mismatched payments right now.</p>
        </div>
      ) : null}

      {data.unmatched.length > 0 && (
        <section className="stack">
          <h2>Payments without a memo</h2>
          <p className="muted" style={{ marginTop: -8 }}>Sent straight to your wallet (for example from an exchange). Confirm which invoice each one pays.</p>
          {data.unmatched.map((p) => (
            <div className="card stack" key={p.id} style={{ gap: 10 }}>
              <div className="row">
                <b className="mono" style={{ fontSize: 18 }}>{fmt(p.amount)} {p.token}</b>
                <span className="muted">from {shortHex(p.from)} · {when(p.timestamp)}</span>
                {p.hold && !p.hold.resolution ? <span className="pill s-review">HELD · {p.hold.detail}</span> : null}
                <span className="spacer" />
                {p.source === "demo" ? <span className="pill s-open">SIMULATED</span> : <a className="mono" style={{ fontSize: 12 }} href={txUrl(p.txHash)} target="_blank" rel="noreferrer">tx {shortHex(p.txHash)}</a>}
              </div>
              {p.suggestions.length ? (
                p.suggestions.map((s, i) => (
                  <div className="suggest" key={s.invoiceId}>
                    <div className="row">
                      <b>{s.number} · {s.customerName}</b>
                      <span className="pill s-review">{s.confidence}% match</span>
                    </div>
                    <span className="muted" style={{ fontSize: 12.5 }}>{s.reasons.join(" · ")}</span>
                    <div className="row">
                      <button className={`btn sm ${i === 0 ? "primary" : ""}`} disabled={!!busy} onClick={() => act(p.id, { action: "assign", payment: p.key, invoiceId: s.invoiceId })}>
                        Confirm match
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>No open invoice fits this amount.</p>
              )}
              <div className="row">
                <input className="input mono" style={{ maxWidth: 220 }} placeholder="Or type an invoice id" value={pick[p.id] ?? ""} onChange={(e) => setPick({ ...pick, [p.id]: e.target.value })} />
                <button className="btn sm" disabled={!!busy || !pick[p.id]} onClick={() => act(p.id, { action: "assign", payment: p.key, invoiceId: pick[p.id] })}>Assign</button>
                {p.hold && !p.hold.resolution ? (
                  <button className="btn sm danger" disabled={!!busy} onClick={() => act(p.id, { action: "return", payment: p.key })}>Return to sender</button>
                ) : null}
                {p.source === "demo" ? (
                  <button className="btn sm danger" disabled={!!busy} onClick={() => removeDemo(p)}>Delete</button>
                ) : (
                  <button className="btn sm danger" disabled={!!busy} onClick={() => dismiss(p)}>Void</button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {data.held.length > 0 && (
        <section className="stack">
          <h2>Held by your limits</h2>
          <p className="muted" style={{ marginTop: -8 }}>These arrived outside a limit you set, so they weren't booked. Accept them, or send the money back.</p>
          <div className="panel tbl-wrap">
            <table>
              <thead><tr><th>Received</th><th>Invoice</th><th>Why it's held</th><th className="num">Amount</th><th></th></tr></thead>
              <tbody>
                {data.held.map((p) => (
                  <tr key={p.id}>
                    <td className="muted">{when(p.timestamp)}</td>
                    <td><Link href={`/app/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link> · {p.customerName}</td>
                    <td style={{ whiteSpace: "normal", minWidth: 240 }}>{p.hold?.detail}</td>
                    <td className="num">{fmt(p.amount)}</td>
                    <td>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <button className="btn primary sm" disabled={!!busy} onClick={() => act(p.id, { action: "accept", payment: p.key })}>Accept</button>
                        <button className="btn sm danger" disabled={!!busy} onClick={() => act(p.id, { action: "return", payment: p.key })}>Return</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.invoices.length > 0 && (
        <section className="stack">
          <h2>Invoices that need a decision</h2>
          <div className="panel tbl-wrap">
            <table>
              <thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>What's needed</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id} className="click" onClick={() => (window.location.href = `/app/invoices/${i.id}`)}>
                    <td className="mono">{i.number}</td>
                    <td>{i.customerName}</td>
                    <td><span className={`pill ${i.pill}`}>{i.state.label}</span></td>
                    <td className="muted">
                      {i.state.status === "underpaid" ? `${fmt(i.state.balance)} still due: chase or write off` : i.state.status === "overpaid" ? `${fmt(i.state.excessOpen)} extra: refund or credit` : `${fmt(i.state.duplicateOpen)} duplicate: refund or credit`}
                    </td>
                    <td className="num">{fmt(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.refunds.length > 0 && (
        <section className="stack">
          <h2>Refunds in progress</h2>
          <div className="panel tbl-wrap">
            <table>
              <thead><tr><th>Invoice</th><th>To</th><th>Status</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.refunds.map((r) => (
                  <tr key={r.id} className="click" onClick={() => r.invoiceId && (window.location.href = `/app/invoices/${r.invoiceId}`)}>
                    <td>{r.invoiceNumber ?? "Returned payment"}</td>
                    <td className="mono">{shortHex(r.to)}</td>
                    <td><span className="pill s-review">{r.status === "pending_approval" ? "NEEDS APPROVAL" : "READY TO SEND"}</span></td>
                    <td className="num">{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.refunds.filter((r) => !r.invoiceId).map((r) => (
            <RefundCard key={r.id} refund={r} merchant={r.merchant} onDone={() => { reload(); refresh(); }} />
          ))}
        </section>
      )}
    </>
  );
}
