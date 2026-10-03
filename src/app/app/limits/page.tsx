"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { Limits } from "@/lib/types";

const RULES: { key: keyof Limits; title: string; help: string }[] = [
  { key: "maxPerPayment", title: "Max per payment", help: "Checkout links refuse larger amounts. A bigger transfer sent another way is held for review." },
  { key: "dailyCap", title: "Daily incoming cap", help: "Once reached, payment links pause for the rest of the day (UTC). Anything above it is held." },
  { key: "perCustomerMonthlyCap", title: "Per-customer monthly cap", help: "Per paying wallet, per calendar month. Useful for new or unverified payers." },
  { key: "refundApprovalAbove", title: "Refunds need a second approval above", help: "Larger refunds wait for an approval signature before they can be sent." },
];

const toInput = (u: string | null) => (u === null ? "" : fmt(u, { min: 0 }).replace(/,/g, ""));

export default function LimitsPage() {
  const { data, reload } = useApi<{ limits: Limits; name: string; publicAmounts: boolean; receivedToday: string }>("/api/limits");
  const [form, setForm] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [publicAmounts, setPublicAmounts] = useState(true);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(RULES.map((r) => [r.key, toInput(data.limits[r.key])])));
    setName(data.name);
    setPublicAmounts(data.publicAmounts);
  }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/limits", { method: "PUT", json: { name, publicAmounts, limits: Object.fromEntries(RULES.map((r) => [r.key, form[r.key]?.trim() ? form[r.key].trim() : null])) } });
      setMsg({ kind: "ok", text: "Saved. New limits apply to the next payment." });
      reload();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="muted">Loading…</p>;
  const cap = data.limits.dailyCap ? BigInt(data.limits.dailyCap) : null;
  const today = BigInt(data.receivedToday);
  const pct = cap ? Math.min(100, Number((today * 100n) / (cap || 1n))) : 0;

  return (
    <>
      <div className="page-h">
        <div>
          <h1>Limits & settings</h1>
          <p>Rules you set once. Clearmark enforces them everywhere it controls the flow.</p>
        </div>
      </div>
      <form className="stack" style={{ maxWidth: 760 }} onSubmit={save}>
        <div className="rule">
          <div>
            <b>Business name</b>
            <p>Shown to customers on payment links and receipts.</p>
          </div>
          <input className="input" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <div className="rule">
          <div>
            <b>Show amounts on share cards</b>
            <p>When a receipt link is shared, the preview shows the amount. Turn this off to show only "Payment received" and the settled stamp. The receipt itself still shows the amount, since it's the proof.</p>
          </div>
          <label className="check" style={{ alignItems: "center" }}>
            <input type="checkbox" checked={publicAmounts} onChange={(e) => setPublicAmounts(e.target.checked)} aria-label="Show amounts on share cards" />
            <span>{publicAmounts ? "Shown" : "Hidden"}</span>
          </label>
        </div>
        {RULES.map((r) => (
          <div className="rule" key={r.key}>
            <div>
              <b>{r.title}</b>
              <p>{r.help}</p>
            </div>
            <label className="amt-in">
              <input inputMode="decimal" placeholder="No limit" value={form[r.key] ?? ""} onChange={(e) => setForm({ ...form, [r.key]: e.target.value })} aria-label={r.title} />
              <span>USDC</span>
            </label>
            {r.key === "dailyCap" && cap ? (
              <div style={{ gridColumn: "1/-1", display: "flex", gap: 10, alignItems: "center" }}>
                <div className="meterbar" style={{ flex: 1, marginTop: 0 }}><i style={{ width: `${pct}%` }} /></div>
                <span className="mono muted" style={{ fontSize: 11.5 }}>{fmt(today)} of {fmt(cap)} today</span>
              </div>
            ) : null}
          </div>
        ))}
        <p className="notice" style={{ fontSize: 13 }}>
          Nobody can stop someone from sending USDC straight to a wallet address. So Clearmark enforces limits on its own payment links and refunds, and holds anything that arrives outside them for your review. It is never booked silently.
        </p>
        {msg ? <p className={`notice ${msg.kind}`}>{msg.text}</p> : null}
        <div className="row">
          <button className="btn primary" disabled={busy}>{busy ? <span className="spinner" /> : null} Save settings</button>
          <span className="faint" style={{ fontSize: 12.5 }}>Leave a box empty for no limit.</span>
        </div>
      </form>
    </>
  );
}
