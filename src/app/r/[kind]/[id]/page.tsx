import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { addressUrl, shortHex, txUrl } from "@/lib/arc";
import { LedgerError } from "@/lib/ledger";
import { fmt } from "@/lib/money";
import { receiptData } from "@/lib/receipts";
import { read } from "@/lib/store";
import { ReVerify } from "@/components/ReVerify";
import { CopyLink } from "@/components/CopyLink";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proof receipt · Clearmark", robots: { index: false } };

export default async function Receipt({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  let r;
  try {
    r = receiptData(await read(), kind, id);
  } catch (e) {
    if (e instanceof LedgerError) notFound();
    throw e;
  }
  const at = new Date(r.at);
  return (
    <div className="stage">
      <div className="stack" style={{ justifyItems: "center", width: "100%" }}>
        <div className="rc">
          <div className="rc-h">
            <div>
              <span className="eyebrow">{r.kind === "refund" ? "Refund receipt" : "Proof receipt"}</span>
              <h1 style={{ marginTop: 8 }}>{r.title}</h1>
              <p>
                {r.invoice ? `${r.invoice.number} · ${r.invoice.title} · ` : ""}
                {r.merchantName}
              </p>
            </div>
            <div className="seal" aria-label={`Clearmark seal: ${r.seal}`}>
              CLEARMARK<b>{r.seal}</b>ARC TESTNET
            </div>
          </div>
          <div className="rc-grid">
            <div><span>{r.kind === "refund" ? "Refunded on" : "Paid on"}</span><b>{at.toUTCString().replace("GMT", "UTC")}</b></div>
            <div><span>{r.kind === "refund" ? "Reason" : "Matched by"}</span><b>{r.matchedBy}</b></div>
            <div><span>From</span><b className="mono"><a href={addressUrl(r.from)} target="_blank" rel="noreferrer">{shortHex(r.from, 8, 6)}</a></b></div>
            <div><span>To</span><b className="mono"><a href={addressUrl(r.to)} target="_blank" rel="noreferrer">{shortHex(r.to, 8, 6)}</a></b></div>
            <div><span>Amount</span><b className="mono">{fmt(r.amount)} USDC</b></div>
            <div>
              <span>Transaction</span>
              <b className="mono">{r.source === "demo" ? "simulated (demo)" : <a href={txUrl(r.txHash)} target="_blank" rel="noreferrer">{shortHex(r.txHash, 10, 8)}</a>}</b>
            </div>
            {r.invoice ? (
              <div><span>Invoice status</span><b>{r.invoice.label} · {fmt(r.invoice.amount)} USDC</b></div>
            ) : null}
            <div><span>Memo ID</span><b className="mono" title={r.memoId ?? ""}>{r.memoId ? shortHex(r.memoId, 10, 8) : "none"}</b></div>
          </div>
          <div className="rc-f">
            {r.note ? <p className="muted" style={{ fontSize: 13.5 }}>{r.note}</p> : null}
            {r.related.length ? (
              <div className="row" style={{ fontSize: 13 }}>
                {r.related.map((x) => <Link key={x.href} href={x.href}>{x.label} →</Link>)}
              </div>
            ) : null}
            <div className="row">
              <ReVerify kind={r.kind} source={r.source} txHash={r.txHash} from={r.from} to={r.to} amount={r.amount} memoId={r.memoId} />
              <CopyLink />
            </div>
          </div>
        </div>
        <p className="faint" style={{ fontSize: 12 }}>
          Issued by Clearmark. Anyone with this link can check it against Arc testnet.
        </p>
      </div>
    </div>
  );
}
