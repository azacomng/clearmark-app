"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi, date } from "@/lib/client";
import { fmt } from "@/lib/money";
import { CountUp } from "@/components/Fx";
import { IconBolt, IconClock, IconInbox, IconWallet } from "@/components/Icons";
import type { dashboard } from "@/lib/service";
import { useShell } from "@/components/AppShell";
import { InvoiceDetail } from "@/components/InvoiceDetail";

type Dash = ReturnType<typeof dashboard>;
type Inv = Dash["invoices"][number];

const toNum = (u: string) => Number(BigInt(u)) / 1e6;

/** Smooth SVG path through points (Catmull-Rom to cubic Bezier). */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Cumulative USDC collected across invoices in creation order. Decorative curve when there is no data yet. */
function Wave({ invoices }: { invoices: Inv[] }) {
  const W = 600, H = 110;
  const live = invoices.filter((i) => i.state.status !== "void").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let acc = 0;
  const vals = live.map((i) => (acc += toNum(i.state.counted)));
  const series = vals.length >= 2 && acc > 0 ? [0, ...vals] : [0.35, 0.5, 0.42, 0.62, 0.55, 0.78, 0.7, 0.9];
  const max = Math.max(...series) || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * W, H - 10 - (v / max) * (H - 24)] as [number, number]);
  const line = smooth(pts);
  return (
    <svg className="wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="wg" x1="0" x2="1">
          <stop offset="0" stopColor="#7F8CFF" />
          <stop offset=".5" stopColor="#B57BFF" />
          <stop offset="1" stopColor="#3EE6E0" />
        </linearGradient>
        <linearGradient id="wf" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#8B9DFF" stopOpacity=".28" />
          <stop offset="1" stopColor="#8B9DFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="a" d={`${line} L${W},${H} L0,${H} Z`} />
      <path className="l" d={line} />
    </svg>
  );
}

const GROUPS = [
  { key: "paid", label: "Paid", color: "var(--ok)", match: (s: string) => s === "paid" },
  { key: "open", label: "Open / partial", color: "var(--accent)", match: (s: string) => s === "open" || s === "partial" },
  { key: "act", label: "Needs action", color: "var(--warn)", match: (s: string) => ["underpaid", "overpaid", "duplicate"].includes(s) },
] as const;

function Ring({ invoices }: { invoices: Inv[] }) {
  const live = invoices.filter((i) => i.state.status !== "void");
  const billed = live.reduce((a, i) => a + toNum(i.amount), 0);
  const counted = live.reduce((a, i) => a + Math.min(toNum(i.state.counted), toNum(i.amount)), 0);
  const pct = billed ? Math.round((counted / billed) * 100) : 0;
  const counts = GROUPS.map((g) => live.filter((i) => g.match(i.state.status)).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const R = 62, C = 2 * Math.PI * R, gap = counts.filter(Boolean).length > 1 ? 6 : 0;
  let off = 0;
  return (
    <div className="ringcard glow-edge">
      <div className="ring">
        <svg viewBox="0 0 150 150">
          <circle className="trk" cx="75" cy="75" r={R} />
          {total > 0 &&
            GROUPS.map((g, i) => {
              const len = (counts[i] / total) * C;
              if (!len) return null;
              const el = (
                <circle key={g.key} className="arcs" cx="75" cy="75" r={R} style={{ stroke: g.color, color: g.color }}
                  strokeDasharray={`${Math.max(len - gap, 0.01)} ${C}`} strokeDashoffset={-off} />
              );
              off += len;
              return el;
            })}
        </svg>
        <div className="ctr">
          <b>{pct}%</b>
          <span>collected</span>
        </div>
      </div>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <h3>Invoice health</h3>
          <p className="muted" style={{ fontSize: 12.5 }}>
            {counted.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of{" "}
            {billed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC billed
          </p>
        </div>
        <div className="legend">
          {GROUPS.map((g, i) => (
            <div key={g.key}>
              <i style={{ background: g.color, color: g.color }} />
              <span>{g.label}</span>
              <b>{counts[i]}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  if (!data)
    return (
      <p className="muted row">
        <span className="spinner" /> Loading your ledger…
      </p>
    );
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

      <div className="dash-hero">
        <div className="vault glow-edge">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="eyebrow">Received this month</span>
            <span className="chip"><i className="dot live" /> live on Arc</span>
          </div>
          <div className="big">
            <CountUp value={fmt(k.receivedMonth)} />
            <small>USDC</small>
          </div>
          <div className="sub">
            <div><b>{k.paymentsMonth}</b>payments</div>
            <div><b>{fmt(k.refunded)}</b>refunded</div>
            <div><b>{fmt(k.credits)}</b>customer credit</div>
          </div>
          <Wave invoices={data.invoices} />
        </div>
        <Ring invoices={data.invoices} />
      </div>

      <div className="kpis">
        <div className="kpi" style={{ ["--kglow" as string]: "var(--ok)" }}>
          <span><i className="ico" style={{ color: "var(--ok)", background: "var(--ok-soft)" }}><IconBolt /></i>Auto-matched</span>
          <b>{k.autoMatched === null ? "–" : `${k.autoMatched}%`}</b>
          <small>{k.autoMatchedOf[0]} of {k.autoMatchedOf[1]} by memo</small>
          <div className="meterbar"><i style={{ width: `${k.autoMatched ?? 0}%` }} /></div>
        </div>
        <div className="kpi" style={{ ["--kglow" as string]: "var(--accent-2)" }}>
          <span><i className="ico"><IconWallet /></i>Outstanding</span>
          <b><CountUp value={fmt(k.outstanding)} /></b>
          <small style={{ color: k.overdueCount ? "var(--warn)" : undefined }}>
            {k.outstandingCount} invoices{k.overdueCount ? ` · ${k.overdueCount} overdue` : ""}
          </small>
        </div>
        <div className="kpi" style={{ ["--kglow" as string]: "var(--warn)" }}>
          <span><i className="ico" style={{ color: "var(--warn)", background: "var(--warn-soft)" }}><IconClock /></i>Overdue</span>
          <b>{k.overdueCount}</b>
          <small>{k.overdueCount ? "chase or extend these" : "nothing late"}</small>
        </div>
        <div className="kpi" style={{ ["--kglow" as string]: "var(--seal)" }}>
          <span><i className="ico" style={{ color: "var(--seal)", background: "var(--seal-soft)" }}><IconInbox /></i>Needs review</span>
          <b>{k.reviewCount}</b>
          <small>
            <Link href="/app/review">Open the inbox →</Link>
          </small>
        </div>
      </div>

      {data.invoices.length === 0 ? (
        <div className="card empty glow-edge">
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
            <div className="panel-h">Invoice detail<span>live</span></div>
            <div className="panel-b">{sel ? <InvoiceDetail key={sel} id={sel} compact /> : <p className="muted">Pick an invoice.</p>}</div>
          </div>
        </div>
      )}
    </>
  );
}
