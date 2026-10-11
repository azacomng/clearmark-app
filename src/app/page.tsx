import Link from "next/link";
import { redirect } from "next/navigation";
import { sessionAddress } from "@/lib/auth";
import { Brand } from "@/components/Brand";
import { SignIn } from "@/components/SignIn";
import { IconBolt, IconClock, IconHistory, IconInvoices, IconReceipt, IconShield, IconWallet } from "@/components/Icons";

export const dynamic = "force-dynamic";

const RULES = [
  ["200.00", "UNDERPAID", "s-under", "Invoice stays open and the customer gets a link for the 50.00 balance."],
  ["250.00", "PAID", "s-paid", "Matched by its onchain memo. A receipt is issued on the spot."],
  ["300.00", "OVERPAID", "s-over", "Paid, with 50.00 to refund or keep as customer credit."],
  ["250 × 2", "DUPLICATE", "s-dup", "The second payment is flagged and queued for refund."],
  ["125 + 125", "PAID · SPLIT", "s-paid", "Shows partial after the first, paid after the second."],
  ["untagged", "NEEDS REVIEW", "s-review", "Clearmark suggests the best invoice match for one-click review."],
] as const;

const TICKER = [
  ["s-paid", "PAID", "INV-10042", "250.00"],
  ["s-partial", "PARTIAL", "INV-10043", "125.00"],
  ["s-over", "OVERPAID", "INV-10039", "300.00"],
  ["s-paid", "PAID · SPLIT", "INV-10043", "250.00"],
  ["s-review", "NEEDS REVIEW", "untagged", "250.00"],
  ["s-under", "UNDERPAID", "INV-10044", "200.00"],
  ["s-dup", "DUPLICATE", "INV-10042", "250.00"],
  ["s-paid", "PAID · WITHIN TOLERANCE", "INV-10046", "249.70"],
  ["s-paid", "PAID · EARLY DISCOUNT", "INV-10047", "245.00"],
  ["s-paid", "PAID OUT", "3 collaborators", "1,000.00"],
] as const;

const CHAINS = ["Base", "Ethereum", "Arbitrum", "OP", "Avalanche", "Polygon", "Unichain", "Linea"];

const HEAD = ["Every", "USDC", "payment,"];

export default async function Home() {
  if (await sessionAddress()) redirect("/app");
  return (
    <div className="land">
      <header className="land-top">
        <Brand />
        <div className="row">
          <span className="chip net">Arc mainnet</span>
          <span className="chip">USDC gas</span>
          <span className="chip">finality <b>&lt;1s</b></span>
        </div>
      </header>

      <section className="hero">
        <div>
          <span className="eyebrow">Onchain reconciliation for freelancers & agencies</span>
          <h1>
            {HEAD.map((w, i) => (
              <span key={w} className="w" style={{ animationDelay: `${i * 0.08}s` }}>
                {w}&nbsp;
              </span>
            ))}
            <span className="w grad-text" style={{ animationDelay: ".26s" }}>proven and matched.</span>
          </h1>
          <p className="lede">
            Send an invoice, your customer pays from any wallet, and every transfer lands on the right invoice with a status a
            human can read. Bill in USDC or euros, take payment from any chain, and split it with your team in one click.
            Clearmark never holds your funds: payments go straight to your wallet.
          </p>
          <div className="cta">
            <div className="row" style={{ marginTop: 30, alignItems: "flex-start" }}>
              <SignIn label="Connect wallet & sign in" />
            </div>
            <p className="faint" style={{ fontSize: 12.5, marginTop: 14 }}>
              Live on Arc mainnet. Signing in is a free signature, not a transaction.
            </p>
          </div>
        </div>

        <div className="orbit" aria-hidden="true">
          <div className="core" />
          <div className="r r1"><i /></div>
          <div className="r r2"><i /></div>
          <div className="r r3" />
          <span className="pill s-paid float-pill a">PAID</span>
          <span className="pill s-review float-pill b">NEEDS REVIEW</span>
          <span className="pill s-over float-pill c">OVERPAID</span>
          <div className="proof">
            <div className="top">
              <span>INV-10042 · Brand sprint</span>
              <span className="chip" style={{ padding: "4px 8px" }}>Arc</span>
            </div>
            <div className="amt">
              250.00<small>USDC</small>
            </div>
            <div className="hash">
              <span>memo 0x9f3c…e21a</span>
              <span>block 4,812,907</span>
            </div>
            <div className="steps">
              <div><i />Transfer verified onchain</div>
              <div><i />Memo matched to invoice</div>
              <div><i />Receipt issued</div>
            </div>
            <span className="stamp">Paid</span>
          </div>
        </div>
      </section>

      <div className="ticker" aria-hidden="true">
        <div>
          {[...TICKER, ...TICKER].map(([cls, st, inv, amt], i) => (
            <span key={i} className="t">
              <span className={`pill ${cls}`}>{st}</span>
              {inv} · {amt} USDC
            </span>
          ))}
        </div>
      </div>

      <section className="stats reveal">
        <div className="card"><b className="grad-text">&lt;1s</b><span>Arc finality, so a payment is matched as it lands</span></div>
        <div className="card"><b className="grad-text">9</b><span>Chains your customers can pay from, settling on Arc</span></div>
        <div className="card"><b className="grad-text">0</b><span>Custody. Funds go straight to your wallet</span></div>
        <div className="card"><b className="grad-text">100%</b><span>Of payments and refunds get a verifiable receipt</span></div>
      </section>

      <section className="reveal" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))", gap: 40, alignItems: "center" }}>
        <div className="sec-h">
          <span className="eyebrow">One invoice, every outcome</span>
          <h2>A 250.00 USDC invoice, whatever the customer sends.</h2>
          <p className="muted">
            Each invoice gets an onchain memo fingerprint. Clearmark ties every transfer to it deterministically, then tells you
            in plain words what happened and what to do next.
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

      <section className="reveal" style={{ marginTop: 80 }}>
        <div className="sec-h">
          <span className="eyebrow">Built for proof</span>
          <h2>Everything a finance team asks for. None of the custody.</h2>
        </div>
        <div className="features">
          <div className="card">
            <div className="f-ico"><IconReceipt /></div>
            <h3>A receipt for every transaction</h3>
            <p>Payments in, refunds out, partials and duplicates. Each one has its own receipt that anyone can re-check against Arc.</p>
          </div>
          <div className="card">
            <div className="f-ico"><IconShield /></div>
            <h3>Limits you set</h3>
            <p>Max per payment, a daily cap, a per-customer monthly cap and a second approval for large refunds. Anything outside is held for review.</p>
          </div>
          <div className="card">
            <div className="f-ico"><IconHistory /></div>
            <h3>History you can find</h3>
            <p>One searchable timeline of money in and out, with CSV export that carries the transaction and receipt link on every line.</p>
          </div>
        </div>
      </section>

      <section className="reveal" style={{ marginTop: 96 }}>
        <div className="sec-h">
          <span className="eyebrow">New in Clearmark</span>
          <h2>
            Get paid faster, in more ways, <span className="grad-text">and share it.</span>
          </h2>
        </div>
        <div className="bento">
          <div className="card b-stamp">
            <div className="f-ico"><IconBolt /></div>
            <h3>Settled Stamp</h3>
            <p>Every receipt shows how fast the money landed. Share the link and it unfurls as a branded card in WhatsApp, X or Slack. You choose whether amounts show.</p>
            <div className="demo">
              <div className="mini-receipt">
                <div><span className="faint">Proof receipt</span><b>250.00 USDC received</b></div>
                <span className="mini-seal">PAID</span>
              </div>
              <span className="settled" style={{ margin: 0 }}><span className="settled-dot" />Settled in 0.73s · final</span>
            </div>
          </div>
          <div className="card b-terms">
            <div className="f-ico"><IconClock /></div>
            <h3>Smart Terms</h3>
            <p>Offer 2% off for paying early and a fee for paying late. The checkout shows the live price and a countdown, and Clearmark settles at the price that applied.</p>
            <div className="demo">
              <div className="price-flip">
                <s>250.00</s>
                <b>245.00</b>
                <span className="mono">USDC</span>
              </div>
              <span className="count-pill">Discount ends in 2d 14h 06m</span>
            </div>
          </div>
          <div className="card b-chains">
            <div className="f-ico"><IconWallet /></div>
            <h3>Pay from any chain</h3>
            <p>Customers pay with USDC on eight other networks. Circle&apos;s bridge carries it to Arc, then it pays the invoice with its fingerprint, so it still matches automatically.</p>
            <div className="demo chain-flow">
              <div className="chain-cloud">
                {CHAINS.map((c, i) => (
                  <span key={c} style={{ animationDelay: `${i * 0.35}s` }}>{c}</span>
                ))}
              </div>
              <div className="flow-line"><i /></div>
              <span className="arc-node">Arc</span>
            </div>
          </div>
          <div className="card b-splits">
            <div className="f-ico"><IconInvoices /></div>
            <h3>Payday Splits</h3>
            <p>Name your collaborators and their share. When the invoice is paid, one approval pays everyone from your wallet, and each person gets their own receipt.</p>
            <div className="demo">
              <div className="split-bar">
                <i style={{ flex: 57.5 }}><span>You 57.5%</span></i>
                <i style={{ flex: 30 }}><span>Ana 30%</span></i>
                <i style={{ flex: 12.5 }}><span>Bo</span></i>
              </div>
              <span className="faint mono" style={{ fontSize: 11.5 }}>3 payouts · 1 transaction · 0 custody</span>
            </div>
          </div>
          <div className="card b-euro">
            <div className="f-ico"><IconReceipt /></div>
            <h3>Get paid in euros</h3>
            <p>Send euro invoices. Customers pay in EURC, or in USDC at a rate locked for 15 minutes. The receipt shows both amounts and the rate, and you can convert to EURC in one click.</p>
            <div className="demo">
              <div className="fx-pair">
                <div><b>460.00</b><span>EUR invoiced</span></div>
                <em>=</em>
                <div><b>500.00</b><span>USDC paid</span></div>
              </div>
              <span className="faint mono" style={{ fontSize: 11.5 }}>1 USDC = 0.9200 EUR · rate locked at checkout</span>
            </div>
          </div>
        </div>
      </section>

      <section className="cta-band glow-edge reveal card">
        <div className="f-ico" style={{ marginBottom: 0 }}><IconBolt /></div>
        <h2 style={{ fontSize: "clamp(26px,3.4vw,38px)" }}>
          Get paid in USDC or euros. <span className="grad-text">Know it’s matched.</span>
        </h2>
        <p className="muted" style={{ maxWidth: 520 }}>Sign in with a free wallet signature and send your first invoice in under a minute.</p>
        <SignIn label="Launch the app" />
      </section>

      <footer className="foot">
        <span>© Clearmark · Arc</span>
        <span>
          Built on Arc. <Link href="https://docs.arc.io">Arc docs</Link>
        </span>
      </footer>
    </div>
  );
}
