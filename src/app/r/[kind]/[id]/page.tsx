import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { addressUrl, shortHex, txUrl } from "@/lib/arc";
import { LedgerError } from "@/lib/ledger";
import { fmt } from "@/lib/money";
import { receiptData } from "@/lib/receipts";
import { read } from "@/lib/store";
import { ReVerify } from "@/components/ReVerify";
import { CopyLink } from "@/components/CopyLink";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ kind: string; id: string }> };

async function load(kind: string, id: string) {
  try {
    return receiptData(await read(), kind, id);
  } catch (e) {
    if (e instanceof LedgerError) return null;
    throw e;
  }
}

/** Absolute site origin for link previews: CLEARMARK_PUBLIC_URL if set, else the request host. */
async function origin(): Promise<URL> {
  if (process.env.CLEARMARK_PUBLIC_URL) return new URL(process.env.CLEARMARK_PUBLIC_URL);
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return new URL(`${proto}://${host}`);
}

/** Rich link preview, so a shared proof link renders as a branded card in chat apps. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { kind, id } = await params;
  const r = await load(kind, id);
  if (!r) return { title: "Receipt not found · Clearmark", robots: { index: false } };
  const what = r.kind === "refund" ? "Refund sent" : r.kind === "payout" ? "Payout sent" : "Payment received";
  const title = r.publicAmounts ? `${r.title} · ${r.merchantName}` : `${what} · ${r.merchantName}`;
  const description = `${r.settled}. Proof receipt on Arc${r.source === "demo" ? " (simulated demo payment)" : ""}, verifiable by anyone. Invoice with Clearmark.`;
  return {
    metadataBase: await origin(),
    title: `${title} · Clearmark`,
    description,
    robots: { index: false },
    openGraph: { title, description, type: "website", siteName: "Clearmark" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function Receipt({ params }: Props) {
  const { kind, id } = await params;
  const r = await load(kind, id);
  if (!r) notFound();
  const at = new Date(r.at);
  return (
    <div className="stage">
      <div className="stack" style={{ justifyItems: "center", width: "100%" }}>
        <div className="rc">
          <div className="rc-h">
            <div>
              <span className="eyebrow">{r.kind === "refund" ? "Refund receipt" : r.kind === "payout" ? "Payout receipt" : "Proof receipt"}</span>
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
          {r.kind === "payment" ? (
            <div className="settled" title="Arc finality is deterministic: once a payment is in a block it can't be reversed.">
              <span className="settled-dot" />
              {r.settled}
              {r.source === "demo" ? <em> · simulated</em> : null}
            </div>
          ) : null}
          <div className="rc-grid">
            <div><span>{r.kind === "refund" ? "Refunded on" : r.kind === "payout" ? "Paid out on" : "Paid on"}</span><b>{at.toUTCString().replace("GMT", "UTC")}</b></div>
            <div><span>{r.kind === "payment" ? "Matched by" : "Reason"}</span><b>{r.matchedBy}</b></div>
            <div><span>From</span><b className="mono"><a href={addressUrl(r.from)} target="_blank" rel="noreferrer">{shortHex(r.from, 8, 6)}</a></b></div>
            <div><span>To</span><b className="mono"><a href={addressUrl(r.to)} target="_blank" rel="noreferrer">{shortHex(r.to, 8, 6)}</a></b></div>
            <div><span>Amount</span><b className="mono">{fmt(r.amount)} {r.token}</b></div>
            <div>
              <span>Transaction</span>
              <b className="mono">{r.source === "demo" ? "simulated (demo)" : <a href={txUrl(r.txHash)} target="_blank" rel="noreferrer">{shortHex(r.txHash, 10, 8)}</a>}</b>
            </div>
            {r.invoice ? (
              <div><span>Invoice status</span><b>{r.invoice.label} · {fmt(r.invoice.amount)} {r.invoice.unit}</b></div>
            ) : null}
            {r.fx ? <div style={{ gridColumn: "1/-1" }}><span>Conversion</span><b>{r.fx}</b></div> : null}
            {r.via ? <div><span>Paid from</span><b>{r.via}, bridged to Arc with Circle CCTP</b></div> : null}
            <div><span>Memo ID</span><b className="mono" title={r.memoId ?? ""}>{r.memoId ? shortHex(r.memoId, 10, 8) : "none"}</b></div>
          </div>
          <div className="rc-f">
            {r.note ? <p className="muted" style={{ fontSize: 13.5 }}>{r.note}</p> : null}
            {r.invite ? (
              <div className="suggest" style={{ borderStyle: "solid" }}>
                <b>Get paid like this for your own work</b>
                <span className="muted" style={{ fontSize: 13 }}>
                  {r.merchantName} uses Clearmark to invoice in USDC or euros and split payments with collaborators. Your wallet already works as a free Clearmark workspace: sign in with it to send your own invoices.
                </span>
                <div className="row"><Link className="btn primary sm" href="/?signin=1&ref=split">Claim your free workspace</Link></div>
              </div>
            ) : null}
            {r.related.length ? (
              <div className="row" style={{ fontSize: 13 }}>
                {r.related.map((x) => <Link key={x.href} href={x.href}>{x.label} →</Link>)}
              </div>
            ) : null}
            <div className="row">
              <ReVerify kind={r.kind} source={r.source} txHash={r.txHash} from={r.from} to={r.to} amount={r.amount} memoId={r.memoId} token={r.token} />
              <CopyLink />
            </div>
          </div>
        </div>
        <p className="faint" style={{ fontSize: 12 }}>
          Issued by Clearmark. Anyone with this link can check it against Arc testnet.
        </p>
        <Link href="/" className="madewith">
          Invoice with <b>Clearmark</b> · get paid in USDC or EURC, proven on Arc
        </Link>
      </div>
    </div>
  );
}
