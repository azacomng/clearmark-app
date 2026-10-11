"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { shortHex, txUrl } from "@/lib/arc";
import { useApi, when } from "@/lib/client";
import { fmt } from "@/lib/money";
import type { HistoryRow } from "@/lib/service";
import { useShell } from "@/components/AppShell";

type F = "all" | "in" | "out" | "flag";

export default function History() {
  const { tick } = useShell();
  const { data, error, reload } = useApi<{ rows: HistoryRow[] }>("/api/history");
  const [q, setQ] = useState("");
  const [f, setF] = useState<F>("all");
  const [month, setMonth] = useState("");

  useEffect(() => {
    reload();
  }, [tick, reload]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/,/g, "");
    return (data?.rows ?? []).filter((r) => {
      if (f === "in" && r.kind !== "in") return false;
      if (f === "out" && r.kind !== "out") return false;
      if (f === "flag" && !r.flagged) return false;
      if (month && !r.at.startsWith(month)) return false;
      if (!needle) return true;
      const hay = [r.counterparty, r.invoiceNumber ?? "", r.status, r.address, r.txHash ?? "", fmt(r.amount).replace(/,/g, "")].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [data, q, f, month]);

  const months = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.at.slice(0, 7)))].sort().reverse(), [data]);
  // Totals per token: USDC and EURC are never added together.
  const totals = (["USDC", "EURC"] as const)
    .map((t) => {
      const mine = rows.filter((r) => (r.token ?? "USDC") === t);
      const tin = mine.filter((r) => r.kind === "in").reduce((a, r) => a + BigInt(r.amount), 0n);
      const tout = mine.filter((r) => r.kind === "out").reduce((a, r) => a - BigInt(r.amount), 0n);
      return { t, tin, tout, n: mine.length };
    })
    .filter((x) => x.t === "USDC" || x.n > 0);

  if (error) return <p className="notice bad">{error}</p>;

  return (
    <>
      <div className="page-h">
        <div>
          <h1>History</h1>
          <p>Every transaction in and out. Each row links to its own receipt.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn ghost" href="/app/accounting">Xero / QuickBooks</Link>
          <a className="btn" href="/api/history?format=csv">Export CSV</a>
        </div>
      </div>

      <div className="row">
        <input className="input" style={{ flex: "1 1 280px" }} type="search" placeholder="Search a customer, invoice, amount, wallet or tx hash" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" role="group" aria-label="Filter history">
          {(["all", "in", "out", "flag"] as F[]).map((x) => (
            <button key={x} aria-pressed={f === x} onClick={() => setF(x)}>
              {{ all: "All", in: "Received", out: "Sent out", flag: "Flagged" }[x]}
            </button>
          ))}
        </div>
        <select className="input" style={{ width: "auto" }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          <option value="">All months</option>
          {months.map((m) => (
            <option key={m} value={m}>{new Date(m + "-01T00:00:00Z").toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</option>
          ))}
        </select>
      </div>

      <div className="row muted" style={{ fontSize: 13, gap: 18 }}>
        <span>{rows.length} transactions</span>
        {totals.map(({ t, tin, tout }) => (
          <span key={t}>
            {t}: in <b className="mono" style={{ color: "var(--fg)" }}>{fmt(tin)}</b> · out <b className="mono" style={{ color: "var(--fg)" }}>{fmt(tout)}</b> · net{" "}
            <b className="mono" style={{ color: "var(--fg)" }}>{fmt(tin - tout)}</b>
          </span>
        ))}
      </div>

      <div className="panel">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Type</th><th>Counterparty</th><th>Invoice</th><th>Status</th><th className="num">Amount</th><th>Tx</th><th>Receipt</th></tr>
            </thead>
            <tbody>
              {!data ? (
                <tr><td colSpan={8} className="muted">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="muted">{data.rows.length ? "Nothing matches that search." : "No transactions yet."}</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.kind + r.id} className={r.status === "VOIDED" ? "voided" : undefined}>
                    <td className="muted">{when(r.at)}</td>
                    <td>{r.kind === "in" ? "Received" : r.status === "PAYOUT" ? "Payout" : "Refund"}</td>
                    <td>
                      {r.counterparty}
                      <br />
                      <span className="mono faint" style={{ fontSize: 11 }}>{shortHex(r.address)}</span>
                    </td>
                    <td>{r.invoiceId ? <Link href={`/app/invoices/${r.invoiceId}`}>{r.invoiceNumber}</Link> : <span className="faint">–</span>}</td>
                    <td><span className={`pill ${r.pill}`}>{r.status}</span></td>
                    <td className="num" style={r.kind === "out" ? { color: "var(--muted)" } : undefined}>{fmt(r.amount)} <span className="faint" style={{ fontSize: 11 }}>{r.token ?? "USDC"}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {r.source === "demo" ? <span className="faint">simulated</span> : r.txHash ? <a href={txUrl(r.txHash)} target="_blank" rel="noreferrer">{shortHex(r.txHash)}</a> : null}
                    </td>
                    <td><Link className="mono" style={{ fontSize: 12 }} href={r.receipt}>View</Link></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 12.5 }}>The CSV carries the transaction hash and receipt link on every line, ready for your accountant.</p>
    </>
  );
}
