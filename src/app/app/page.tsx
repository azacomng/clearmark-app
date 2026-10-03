"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi, date } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { dashboard } from "@/lib/service";
import { useShell } from "@/components/AppShell";
import { InvoiceDetail } from "@/components/InvoiceDetail";

type Dash = ReturnType<typeof dashboard>;

export default function Dashboard() {
  const { tick } = useShell();
  const { data, error, reload } = useApi<Dash>("/api/invoices", 10_000);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "attention" | "paid">("all");

  useEffect(() => {
    reload();
  }, [tick, reload]);

  useEffect(() => {
    if (!sel && data?.invoices.length) setSel(data.invoices[0].id);
  }, [data, sel]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const k = data.kpis;
  const list = data.invoices.filter((i) => {
    const s = i.state.status;
    if (filter === "open") return s === "open" || s === "partial";
    if (filter === "attention") return ["underpaid", "overpaid", "duplicate"].includes(s);
    if (filter === "paid") return s === "paid";
    return true;
  });

  return (
    <>
      <div className="page-h">
        <div>
          <h1>Invoices</h1>
          <p>Every payment to your wallet, matched to the invoice it belongs to.</p>
        </div>
        <Link href="/app/invoices/new" className="btn primary">New invoice</Link>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span>Received this month</span>
          <b>{fmt(k.receivedMonth)}</b>
          <small>{k.paymentsMonth} payments · USDC</small>
        </div>
        <div className="kpi">
          <span>Auto-matched</span>
          <b>{k.autoMatched === null ? "–" : `${k.autoMatched}%`}</b>
          <small>{k.autoMatchedOf[0]} of {k.autoMatchedOf[1]} by memo</small>
          <div className="meterbar"><i style={{ width: `${k.autoMatched ?? 0}%`, background: "var(--ok)" }} /></div>
        </div>
        <div className="kpi">
          <span>Outstanding</span>
          <b>{fmt(k.outstanding)}</b>
          <small style={{ color: k.overdueCount ? "var(--warn)" : undefined }}>
            {k.outstandingCount} invoices{k.overdueCount ? ` · ${k.overdueCount} overdue` : ""}
          </small>
        </div>
        <div className="kpi">
          <span>Needs review</span>
          <b>{k.reviewCount}</b>
          <small>
            <Link href="/app/review">Open the inbox →</Link>
          </small>
        </div>
      </div>

      {data.invoices.length === 0 ? (
        <div className="card empty">
          <h2>Create your first invoice</h2>
          <p>You get a payment link to send your customer. Their payment is matched here the moment it lands.</p>
          <Link href="/app/invoices/new" className="btn primary">New invoice</Link>
          {data.demo ? <p className="faint" style={{ fontSize: 12.5 }}>Demo mode is on: you can simulate payments from any invoice.</p> : null}
        </div>
      ) : (
        <div className="two">
          <div className="panel">
            <div className="panel-h">
              <div className="seg" role="group" aria-label="Filter invoices" style={{ padding: 3 }}>
                {(["all", "open", "attention", "paid"] as const).map((f) => (
                  <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {{ all: "All", open: "Open", attention: "Needs action", paid: "Paid" }[f]}
                  </button>
                ))}
              </div>
              <span>{list.length} shown</span>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id} className={`click ${sel === i.id ? "sel" : ""}`} onClick={() => setSel(i.id)}>
                      <td className="mono">{i.number}</td>
                      <td>{i.customerName}</td>
                      <td className={i.state.overdue ? "" : "muted"} style={i.state.overdue ? { color: "var(--warn)" } : undefined}>
                        {date(i.dueDate)}
                      </td>
                      <td><span className={`pill ${i.pill}`}>{i.state.label}</span></td>
                      <td className="num">{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="panel-h">Detail</div>
            <div className="panel-b">{sel ? <InvoiceDetail key={sel} id={sel} compact /> : <p className="muted">Pick an invoice.</p>}</div>
          </div>
        </div>
      )}
    </>
  );
}
