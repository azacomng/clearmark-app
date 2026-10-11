"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { shortHex, txUrl } from "@/lib/arc";
import { api, date, useApi, when } from "@/lib/client";
import { needsFx, toTokenUnits } from "@/lib/fx";
import { fmt } from "@/lib/money";
import type { InvoiceView, PaymentView } from "@/lib/service";
import type { Refund } from "@/lib/types";
import { friendlyError } from "@/lib/wallet";
import { useShell } from "./AppShell";
import { ConvertCard } from "./ConvertCard";
import { useConfirm } from "./Confirm";
import { PayoutCard } from "./PayoutCard";
import { RefundCard, refundConfirm, useRefundActions } from "./RefundCard";

type RefundView = Refund & { invoiceNumber: string | null; customerName: string | null };
interface Detail {
  invoice: InvoiceView;
  payments: PaymentView[];
  refunds: RefundView[];
}

const PAYMENT_VOID_REASONS = ["Sent by mistake", "Test payment", "Not for this invoice"];
const INVOICE_VOID_REASONS = ["Created by mistake", "Customer cancelled", "Replaced by a new invoice"];

const pct = (a: string, b: string) => {
  const x = BigInt(a), y = BigInt(b);
  if (y === 0n) return 0;
  const p = Number((x * 1000n) / y) / 10;
  return Math.min(100, p);
};

export function InvoiceDetail({ id, compact = false }: { id: string; compact?: boolean }) {
  const { tick, refresh, demo } = useShell();
  const { data, error, reload } = useApi<Detail>(`/api/invoices/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const { ask, dialog } = useConfirm();
  const refundActions = useRefundActions(data?.invoice.merchant ?? "");

  useEffect(() => {
    reload();
  }, [tick, reload]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { invoice: inv, payments, refunds } = data;
  const st = inv.state;
  const link = typeof window !== "undefined" ? `${window.location.origin}/pay/${inv.id}` : `/pay/${inv.id}`;

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: "ok", text: ok });
      await reload();
      refresh();
    } catch (e) {
      setMsg({ kind: "bad", text: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  }

  const post = (path: string, json: unknown) => api(path, { method: "POST", json });

  const simulate = (amount: string, extra: Record<string, unknown> = {}) =>
    act(`sim${amount}`, () => post("/api/demo/pay", { invoiceId: inv.id, amount, token: inv.currency === "EUR" ? "EURC" : "USDC", ...extra }));

  const amt = fmt(inv.amount);
  const u = inv.unit;
  const done = () => {
    reload();
    refresh();
  };
  const openSurplus = (p: PaymentView) =>
    BigInt(p.surplus) - inv.resolutions.filter((r) => r.paymentId === p.id).reduce((a, r) => a + BigInt(r.amount), 0n);
  const surplusPayments = payments.filter((p) => ["duplicate", "over", "excess"].includes(p.cls ?? "") && openSurplus(p) > 0n);
  const openRefunds = refunds.filter((r) => r.status !== "sent");
  const canRefund = (p: PaymentView) => !p.voided && openSurplus(p) > 0n && !openRefunds.some((r) => r.paymentId === p.id);
  const toHandle = surplusPayments.filter(canRefund);
  const surplusTotal = toHandle.reduce((a, p) => a + openSurplus(p), 0n);
  const canVoid = (p: PaymentView) =>
    !p.voided && !refunds.some((r) => r.paymentId === p.id) && !inv.resolutions.some((r) => r.paymentId === p.id);

  // How an extra payment was settled, once nothing is left open on it.
  const handledLabel = (p: PaymentView) => {
    if (BigInt(p.surplus) === 0n || openSurplus(p) > 0n) return "";
    const refunded = refunds.some((r) => r.paymentId === p.id && r.status === "sent");
    const credited = inv.resolutions.some((r) => r.paymentId === p.id && r.kind === "credit");
    return refunded && credited ? " · refunded and credited" : refunded ? " · refunded" : credited ? " · kept as credit" : "";
  };

  // Refund straight from the timeline: confirm, prepare, then send (unless it needs a second approval first).
  async function refund(p: PaymentView) {
    // Open surplus is in invoice units. A USDC payment on a EUR invoice goes back in USDC at its own rate,
    // capped at what was paid, the same way the server prepares it.
    const left = openSurplus(p);
    let amount = p.fx && needsFx(inv.currency, p.token) ? toTokenUnits(left, BigInt(p.fx.rate)) : left;
    if (amount > BigInt(p.amount)) amount = BigInt(p.amount);
    if ((await ask(refundConfirm({ amount: amount.toString(), to: p.from, source: p.source, token: p.token }))) === null) return;
    setBusy(`rf${p.id}`);
    setMsg(null);
    try {
      const r = await post("/api/refunds", { payment: p.key }) as Refund;
      if (r.status === "ready") {
        await refundActions.send(r);
        setMsg({ kind: "ok", text: `Refunded ${fmt(r.amount)} ${r.token ?? "USDC"} to ${shortHex(r.to)}.` });
      } else {
        setMsg({ kind: "ok", text: "Refund prepared. It's above your approval limit, so approve it below before it's sent." });
      }
    } catch (e) {
      setMsg({ kind: "bad", text: `${friendlyError(e)} The refund wasn't sent.` });
    } finally {
      setBusy(null);
      await reload();
      refresh();
    }
  }

  async function voidPayment(p: PaymentView) {
    const reason = await ask({
      title: `Void this ${fmt(p.amount)} ${p.token} payment?`,
      body: (
        <>
          It stops counting toward {inv.number} and stays in the history, crossed out. No money moves: if it should go back to the payer, refund it
          instead. A void can&apos;t be undone.
        </>
      ),
      confirmLabel: "Void payment",
      danger: true,
      reason: { presets: PAYMENT_VOID_REASONS, placeholder: "Why is this payment void?" },
    });
    if (reason === null) return;
    await act(`vp${p.id}`, () => post("/api/review", { action: "void", payment: p.key, reason }), "Payment voided.");
  }

  async function deleteDemo(p: PaymentView) {
    const ok = await ask({
      title: `Delete this simulated ${fmt(p.amount)} ${p.token} payment?`,
      body: (
        <>
          It&apos;s removed with its receipt{refunds.some((r) => r.paymentId === p.id) ? " and its simulated refund" : ""}, and {inv.number} is
          worked out again as if it never arrived. Only simulated payments can be deleted.
        </>
      ),
      confirmLabel: "Delete payment",
      danger: true,
    });
    if (ok === null) return;
    await act(`dp${p.id}`, () => post("/api/demo/delete", { payment: p.key }), "Simulated payment deleted.");
  }

  async function voidInvoice() {
    const reason = await ask({
      title: `Void ${inv.number}?`,
      body: <>Its payment link stops taking payments. The invoice stays in your history, crossed out. A void can&apos;t be undone.</>,
      confirmLabel: "Void invoice",
      danger: true,
      reason: { presets: INVOICE_VOID_REASONS, placeholder: "Why is this invoice void?" },
    });
    if (reason === null) return;
    await act("void", () => post(`/api/invoices/${inv.id}`, { action: "void", reason }), "Invoice voided.");
  }

  return (
    <div className="stack">
      {dialog}
      <div className="inv-head">
        <div>
          <div className="id">
            {inv.number} · {inv.customerName}
          </div>
          <div className="what">{inv.title}</div>
        </div>
        <div>
          <div className="amt">
            {amt}
            <small>{u}</small>
          </div>
          <div className="faint" style={{ fontSize: 12, textAlign: "right" }}>
            Due {date(inv.dueDate)}
          </div>
        </div>
      </div>

      <div className="bar" aria-hidden="true">
        <i style={{ width: `${pct(st.counted, st.price)}%`, background: st.status === "underpaid" ? "var(--warn)" : st.status === "paid" ? "var(--ok)" : undefined }} />
      </div>
      <div className="row mono faint" style={{ fontSize: 12, justifyContent: "space-between" }}>
        <span>Received {fmt(st.received)}</span>
        <span>{BigInt(st.balance) > 0n ? `Balance ${fmt(st.balance)}` : st.status === "void" ? "Void" : "Settled"}</span>
      </div>

      {inv.termsLine ? (
        <p className="faint" style={{ fontSize: 12.5 }}>
          Terms: {inv.termsLine}
          {st.priceKind !== "standard" && BigInt(st.balance) > 0n ? ` · price now ${fmt(st.price)} ${u}` : ""}
        </p>
      ) : null}
      <div className="row">
        <span key={st.label} className={`stamp pop ${inv.pill}`}>{st.label}</span>
        <p className="muted" style={{ fontSize: 13, flex: "1 1 200px" }}>{explain(inv).replaceAll("USDC", u)}</p>
      </div>

      {inv.voided ? (
        <p className="notice">
          <b>Voided</b>
          {inv.voidInfo ? (
            <>
              {" "}by {shortHex(inv.voidInfo.by)} on {when(inv.voidInfo.at)}. Reason: {inv.voidInfo.reason}
            </>
          ) : null}
        </p>
      ) : null}

      {!inv.voided ? (
        <div className="stack" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>Payment link</span>
          <div className="linkbox">
            <span>{link}</span>
            <button
              className="btn sm"
              onClick={() => {
                navigator.clipboard?.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <Link className="btn sm" href={`/pay/${inv.id}`} target="_blank">
              Open
            </Link>
          </div>
          <span className="faint mono" style={{ fontSize: 11 }} title={inv.memoId}>
            Memo fingerprint {shortHex(inv.memoId, 10, 6)}
          </span>
        </div>
      ) : null}

      {msg ? <p className={`notice ${msg.kind}`}>{msg.text}</p> : null}

      {/* Actions the engine says are needed */}
      {(st.status === "underpaid" || st.status === "partial") && (
        <div className="suggest">
          <b>{fmt(st.balance)} {u} still due</b>
          <span className="muted" style={{ fontSize: 13 }}>Send the same payment link: it asks for the balance only.</span>
          <div className="row">
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(link)}>Copy balance link</button>
            <button className="btn sm" disabled={!!busy} onClick={() => act("wo", () => post(`/api/invoices/${inv.id}`, { action: "write_off" }), "Balance written off.")}>
              Write off {fmt(st.balance)}
            </button>
          </div>
        </div>
      )}
      {surplusTotal > 0n ? (
        <div className="suggest">
          <b>
            Extra money to handle: {fmt(surplusTotal)} {u}
          </b>
          <span className="muted" style={{ fontSize: 13 }}>
            {toHandle.length === 1
              ? "One payment brought more than the invoice asked for."
              : `${toHandle.length} payments brought more than the invoice asked for.`}{" "}
            Refund each one or keep it as customer credit, right on its line below.
          </span>
        </div>
      ) : null}
      <PayoutCard inv={inv} onDone={done} />
      <ConvertCard inv={inv} onDone={done} />
      {openRefunds.map((r) => (
        <RefundCard key={r.id} refund={r} merchant={inv.merchant} onDone={() => { setMsg({ kind: "ok", text: r.status === "pending_approval" ? "Refund approved." : "Refund updated." }); reload(); refresh(); }} />
      ))}

      <div className="tl">
        <div>
          <b>Invoice created</b> · {when(inv.createdAt)}
        </div>
        {payments.map((p) => (
          <div key={p.id} className={p.voided ? "voided" : undefined}>
            <b>
              {fmt(p.amount)} {p.token} received{p.token === "USDC" && u === "EUR" ? ` · worth ${fmt(p.value)} EUR` : ""}
            </b> · {p.voided ? "voided" : p.hold && !p.hold.resolution ? "held for review" : p.clsLabel ?? "unmatched"}
            {!p.voided ? handledLabel(p) : ""}
            {p.matchMethod === "manual" ? " · matched by you" : ""}
            <br />
            <span className="mono" style={{ fontSize: 11.5 }}>
              {when(p.timestamp)} ·{" "}
              {p.source === "demo" ? "simulated" : (
                <a href={txUrl(p.txHash)} target="_blank" rel="noreferrer">tx {shortHex(p.txHash)}</a>
              )}{" "}
              · <Link href={`/r/p/${p.key}`}>receipt</Link>
              {p.source === "demo" && !inv.payouts.length ? (
                <>
                  {" "}·{" "}
                  <button className="linkish" disabled={!!busy} onClick={() => deleteDemo(p)}>
                    delete
                  </button>
                </>
              ) : !inv.voided && p.source !== "demo" && canVoid(p) ? (
                <>
                  {" "}·{" "}
                  <button className="linkish" disabled={!!busy} onClick={() => voidPayment(p)}>
                    void
                  </button>
                </>
              ) : null}
            </span>
            {p.voided ? (
              <span className="void-note">
                Voided by {shortHex(p.voided.by)} on {when(p.voided.at)} · {p.voided.reason}
              </span>
            ) : null}
            {!inv.voided && canRefund(p) ? (
              <div className="tl-act">
                <button className="btn primary sm" disabled={!!busy} onClick={() => refund(p)}>
                  {busy === `rf${p.id}` ? <span className="spinner" /> : null} Refund {fmt(openSurplus(p))}
                </button>
                <button className="btn sm" disabled={!!busy} onClick={() => act(`cr${p.id}`, () => post(`/api/invoices/${inv.id}`, { action: "credit", paymentId: p.id }), "Kept as customer credit.")}>
                  Keep as credit
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {refunds.filter((r) => r.status === "sent").map((r) => (
          <div key={r.id}>
            <b>{fmt(r.amount)} {r.token ?? "USDC"} refunded</b> · {r.reason.replace("_", " ")}
            <br />
            <span className="mono" style={{ fontSize: 11.5 }}>
              {r.sentAt ? when(r.sentAt) : ""} · <Link href={`/r/f/${r.id}`}>receipt</Link>
            </span>
          </div>
        ))}
        {inv.resolutions.filter((r) => r.kind !== "refund").map((r) => (
          <div key={r.id}>
            <b>{r.kind === "write_off" ? `${fmt(r.amount)} written off` : `${fmt(r.amount)} kept as customer credit`}</b> · {when(r.at)}
          </div>
        ))}
      </div>

      {demo && !inv.voided ? (
        <div className="stack" style={{ gap: 8 }}>
          <span className="eyebrow" style={{ color: "var(--faint)" }}>Demo · simulate a customer payment</span>
          <div className="row">
            <button className="btn sm" disabled={!!busy} onClick={() => simulate(fmt(BigInt(st.balance) > 0n ? st.balance : inv.amount).replace(/,/g, ""))}>Exact {fmt(BigInt(st.balance) > 0n ? st.balance : inv.amount)}</button>
            <button className="btn sm" disabled={!!busy} onClick={() => simulate((Number(inv.amount) * 0.8 / 1e6).toFixed(2))}>Short 80%</button>
            <button className="btn sm" disabled={!!busy} onClick={() => simulate((Number(inv.amount) * 1.2 / 1e6).toFixed(2))}>Over 120%</button>
            <button className="btn sm" disabled={!!busy} onClick={() => simulate((Number(inv.amount) / 2e6).toFixed(2), { intent: "part" })}>Half (split)</button>
            <button className="btn sm" disabled={!!busy} onClick={() => simulate(fmt(inv.amount).replace(/,/g, ""), { tagged: false })}>Untagged</button>
            {inv.currency === "EUR" ? (
              <button className="btn sm" disabled={!!busy} onClick={() => simulate("quote", { token: "USDC" })}>
                Pay in USDC
              </button>
            ) : null}
            <button className="btn sm" disabled={!!busy} onClick={() => (inv.currency === "EUR" ? simulate("quote", { token: "USDC", via: "Base" }) : simulate(fmt(BigInt(st.balance) > 0n ? st.balance : inv.amount).replace(/,/g, ""), { via: "Base" }))}>From Base</button>
          </div>
        </div>
      ) : null}

      {st.status === "open" && !compact ? (
        <button className="btn danger sm" style={{ justifySelf: "start" }} disabled={!!busy} onClick={voidInvoice}>
          Void invoice
        </button>
      ) : null}
      {compact ? (
        <Link href={`/app/invoices/${inv.id}`} className="faint" style={{ fontSize: 12.5 }}>
          Open full invoice →
        </Link>
      ) : null}
    </div>
  );
}

function explain(inv: InvoiceView): string {
  const s = inv.state;
  switch (s.status) {
    case "open":
      return s.overdue ? "Overdue. No payment yet." : "Waiting for payment. Matching happens the moment it lands.";
    case "partial":
      return `${fmt(s.counted)} of ${fmt(s.price)} received as part payments. Waiting for the rest.`;
    case "underpaid":
      return `${fmt(s.balance)} USDC short. ${s.overdue ? "The due date has passed." : ""}`;
    case "overpaid":
      return `Invoice paid, with ${fmt(s.excessOpen)} USDC extra to refund or keep as credit.`;
    case "duplicate":
      return `Invoice paid once. ${fmt(s.duplicateOpen)} USDC arrived again and needs a refund or credit.`;
    case "void":
      return "This invoice was voided. Its link no longer takes payments.";
    default:
      return s.variant === "split"
        ? "Paid in parts, all matched to this invoice."
        : s.variant === "tolerance"
          ? `Paid within your tolerance. Difference ${fmt((BigInt(s.counted) - BigInt(s.price)).toString())} USDC.`
          : s.variant === "written_off"
            ? `Closed with ${fmt(s.writtenOff)} USDC written off.`
            : s.variant === "refunded"
              ? "Paid. Extra money was refunded to the payer."
              : s.variant === "credited"
                ? "Paid. Extra money is held as customer credit."
                : s.variant === "early"
                  ? `Paid early, so the discount applied: ${fmt(s.price)} instead of ${fmt(inv.amount)} USDC.`
                  : s.variant === "late"
                    ? `Paid after the due date with the late fee: ${fmt(s.price)} USDC.`
                : "Paid in full and matched by its onchain memo.";
  }
}
