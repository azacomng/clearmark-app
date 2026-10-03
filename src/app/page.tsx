import Link from "next/link";
import { redirect } from "next/navigation";
import { sessionAddress } from "@/lib/auth";
import { Brand } from "@/components/Brand";
import { SignIn } from "@/components/SignIn";

export const dynamic = "force-dynamic";

const RULES = [
  ["200.00", "UNDERPAID", "s-under", "Invoice stays open and the customer gets a link for the 50.00 balance."],
  ["250.00", "PAID", "s-paid", "Matched by its onchain memo. A receipt is issued on the spot."],
  ["300.00", "OVERPAID", "s-over", "Paid, with 50.00 to refund or keep as customer credit."],
  ["250 × 2", "DUPLICATE", "s-dup", "The second payment is flagged and queued for refund."],
  ["125 + 125", "PAID · SPLIT", "s-paid", "Shows partial after the first, paid after the second."],
  ["untagged", "NEEDS REVIEW", "s-review", "Clearmark suggests the best invoice match for one-click review."],
] as const;

export default async function Home() {
  if (await sessionAddress()) redirect("/app");
  return (
    <div className="land">
      <header className="land-top">
        <Brand />
        <div className="row">
          <span className="chip testnet">Arc testnet</span>
          <span className="chip">USDC gas</span>
          <span className="chip">finality <b>&lt;1s</b></span>
        </div>
      </header>

      <section className="hero">
        <div>
          <span className="eyebrow">For freelancers and small agencies</span>
          <h1>
            Every USDC payment, <em>proven and matched.</em>
          </h1>
          <p className="lede">
            Send an invoice, your customer pays from any wallet, and every transfer lands on the right invoice with a status a
            human can read. Clearmark never holds your funds: payments go straight to your wallet.
          </p>
          <div className="row" style={{ marginTop: 28, alignItems: "flex-start" }}>
            <SignIn label="Sign in with your wallet" />
            <a className="btn" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              Get testnet USDC
            </a>
          </div>
          <p className="faint" style={{ fontSize: 12.5, marginTop: 14 }}>
            Testnet only. Signing in is a free signature, not a transaction.
          </p>
        </div>
        <div className="rules" aria-label="How Clearmark reconciles a 250.00 USDC invoice">
          {RULES.map(([amt, st, cls, what]) => (
            <div key={st}>
              <span className="mono">{amt}</span>
              <span className="muted">{what}</span>
              <span className={`pill ${cls}`}>{st}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="features">
        <div className="card">
          <h3>A receipt for every transaction</h3>
          <p>Payments in, refunds out, partials and duplicates. Each one has its own receipt that anyone can re-check against Arc.</p>
        </div>
        <div className="card">
          <h3>Limits you set</h3>
          <p>Max per payment, a daily cap, a per-customer monthly cap and a second approval for large refunds. Anything outside is held for review.</p>
        </div>
        <div className="card">
          <h3>History you can find</h3>
          <p>One searchable timeline of money in and out, with CSV export that carries the transaction and receipt link on every line.</p>
        </div>
      </section>
      <p className="faint" style={{ marginTop: 40, fontSize: 12.5 }}>
        Built on Arc. <Link href="https://docs.arc.io">Arc docs</Link>
      </p>
    </div>
  );
}
