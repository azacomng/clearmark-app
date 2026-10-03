"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import type { InvoiceView } from "@/lib/service";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export default function NewInvoice() {
  const router = useRouter();
  const [f, setF] = useState({ title: "", customerName: "", customerEmail: "", amount: "", tolerance: "0.50", dueDate: inDays(14), allowSplit: false });
  const [terms, setTerms] = useState({ early: false, earlyPct: "2", earlyDays: "3", late: false, latePct: "1.5" });
  const setT = (k: keyof typeof terms) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTerms({ ...terms, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const t = { earlyPct: terms.early ? terms.earlyPct : null, earlyDays: terms.early ? terms.earlyDays : null, latePct: terms.late ? terms.latePct : null };
      const inv = await api<InvoiceView>("/api/invoices", { method: "POST", json: { ...f, terms: t } });
      router.push(`/app/invoices/${inv.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-h">
        <div>
          <h1>New invoice</h1>
          <p>You get a payment link. When it's paid, the payment is matched to this invoice automatically.</p>
        </div>
      </div>
      <form className="card stack" style={{ maxWidth: 620 }} onSubmit={submit}>
        <label className="field">
          <span>What is it for?</span>
          <input required value={f.title} onChange={set("title")} placeholder="Website design" maxLength={120} />
        </label>
        <div className="row" style={{ alignItems: "stretch" }}>
          <label className="field" style={{ flex: "1 1 220px" }}>
            <span>Customer</span>
            <input required value={f.customerName} onChange={set("customerName")} placeholder="Northwind Studio" maxLength={80} />
          </label>
          <label className="field" style={{ flex: "1 1 220px" }}>
            <span>Customer email (optional)</span>
            <input type="email" value={f.customerEmail} onChange={set("customerEmail")} placeholder="billing@northwind.co" />
          </label>
        </div>
        <div className="row" style={{ alignItems: "stretch" }}>
          <label className="field" style={{ flex: "1 1 160px" }}>
            <span>Amount (USDC)</span>
            <input required inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={f.amount} onChange={set("amount")} placeholder="250.00" className="mono" />
          </label>
          <label className="field" style={{ flex: "1 1 160px" }}>
            <span>Tolerance (USDC)</span>
            <input inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={f.tolerance} onChange={set("tolerance")} className="mono" />
            <small>Payments this close count as paid.</small>
          </label>
          <label className="field" style={{ flex: "1 1 160px" }}>
            <span>Due date</span>
            <input required type="date" value={f.dueDate} onChange={set("dueDate")} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.allowSplit} onChange={set("allowSplit")} />
          <span>
            Allow split payments
            <br />
            <small className="muted">The customer can pay in parts. Each part shows as partial until the total is reached.</small>
          </span>
        </label>
        <div className="stack" style={{ gap: 10 }}>
          <span className="eyebrow">Smart Terms · optional</span>
          <label className="check">
            <input type="checkbox" checked={terms.early} onChange={setT("early")} />
            <span>
              Early-pay discount
              <br />
              <small className="muted">The checkout shows the lower price and a countdown. Whatever price applied at the moment the payment settled on Arc is what counts.</small>
            </span>
          </label>
          {terms.early ? (
            <div className="row" style={{ alignItems: "stretch", paddingLeft: 26 }}>
              <label className="field" style={{ flex: "0 1 140px" }}>
                <span>Discount (%)</span>
                <input inputMode="decimal" className="mono" value={terms.earlyPct} onChange={setT("earlyPct")} />
              </label>
              <label className="field" style={{ flex: "0 1 180px" }}>
                <span>If paid within (days)</span>
                <input inputMode="numeric" className="mono" value={terms.earlyDays} onChange={setT("earlyDays")} />
              </label>
            </div>
          ) : null}
          <label className="check">
            <input type="checkbox" checked={terms.late} onChange={setT("late")} />
            <span>
              Late fee after the due date
              <br />
              <small className="muted">Stated on the invoice and the payment link up front, so the customer sees it before paying.</small>
            </span>
          </label>
          {terms.late ? (
            <div className="row" style={{ alignItems: "stretch", paddingLeft: 26 }}>
              <label className="field" style={{ flex: "0 1 140px" }}>
                <span>Late fee (%)</span>
                <input inputMode="decimal" className="mono" value={terms.latePct} onChange={setT("latePct")} />
              </label>
            </div>
          ) : null}
        </div>
        {err ? <p className="notice bad" role="alert">{err}</p> : null}
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null} Create invoice and link
          </button>
        </div>
      </form>
    </>
  );
}
