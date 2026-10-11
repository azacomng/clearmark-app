# Clearmark

**Every USDC payment, proven and matched.** Clearmark is invoice verification and automatic
reconciliation for USDC on [Arc](https://docs.arc.io). A merchant sends an invoice, the customer pays
from any wallet, and every transfer lands on the right invoice with a status a human can read.

Not a wallet, not a processor, and it never holds funds: payments go straight to the merchant's wallet.

> **Clearmark runs on Arc mainnet (chain id 5042).** Payments are real USDC and EURC. The server refuses to
> start syncing against any other chain id.

## What v1 does

| Customer sends (invoice 250.00) | Status | What Clearmark does |
| --- | --- | --- |
| 250.00 | `PAID` | Matched by its onchain memo, receipt issued |
| 249.70 (tolerance 0.50) | `PAID · WITHIN TOLERANCE` | Accepts it and records the difference |
| 200.00 | `UNDERPAID` | Keeps the invoice open; the same link asks for the 50.00 balance, or write it off |
| 300.00 | `OVERPAID` | Paid, with 50.00 to refund or keep as customer credit |
| 250.00 twice | `DUPLICATE` | Second payment flagged; refund it or keep it as credit |
| 125.00 (part) + 125.00 | `PARTIAL` → `PAID · SPLIT` | Aggregates the parts |
| 250.00 with no memo | `NEEDS REVIEW` | Suggests the most likely invoice with a confidence score |

Plus the three v1 must-haves:

- **A receipt for every transaction**: each payment in and each refund out has a public proof receipt
  (`/r/p/…`, `/r/f/…`) that anyone can re-verify against Arc straight from their browser.
- **Transaction limits**: max per payment, daily incoming cap, per-customer monthly cap, and a second
  (signed) approval for refunds above a threshold. Checkout links enforce them before the customer
  signs; anything that arrives outside a limit is held for review, never silently booked.
- **Easy history**: one searchable timeline of money in and out with filters, monthly view and a CSV
  export that carries the tx hash and receipt link on every line.

Growth features:

- **Settled Stamp share cards**: every payment receipt carries "Settled in 0.8s · final" (measured
  at checkout from the wallet to a final block; Arc finality is deterministic, so "final" is literal).
  A shared receipt link unfurls as a branded preview card (`/r/…/opengraph-image`). Merchants can hide
  amounts on share cards in Settings. Payer-facing pages carry an "Invoice with Clearmark" line.
- **Smart Terms**: an optional early-pay discount (e.g. 2% within 3 days) and late fee after the due
  date, off by default and stated on the invoice and the link. The checkout shows the live price and a
  countdown. Reconciliation judges the invoice at the price that applied at the settle timestamp of the
  payment that covered it (`src/lib/terms.ts`), so 245.00 paid on day 2 of a 250.00 invoice is
  `PAID · EARLY DISCOUNT`, and 250.00 after the due date with a 1.5% fee is short by 3.75.
- **Pay from any chain**: the checkout's "Pay from" menu takes USDC from eight chains (Base, Ethereum,
  Arbitrum, OP, Avalanche, Polygon, Unichain, Linea) through Circle's Bridge Kit (CCTP v2, Arc domain 26)
  to the payer's own wallet on Arc, with Circle's Forwarder doing the mint, then pays the invoice there
  with its memo (`via=<chain>` is recorded on the receipt). A memo can't cross chains, so bridging to the
  merchant directly would arrive untagged; bridge-then-pay keeps every payment deterministic.
- **Payday Splits**: an invoice can name up to 8 collaborators with a percentage each. Once the invoice
  is covered, one transaction through Arc's **Multicall3From** (`0x522f…47D0`) pays every share from the
  merchant's own wallet (each transfer keeps the merchant as sender, so it stays non-custodial). The
  payout is recorded only after every share is verified onchain, and each collaborator gets a payout
  receipt (`/r/s/…`) with an invite to their own workspace. Shares are of the settled price, never of an
  overpayment.
- **Get paid in euros**: EUR invoices are paid in **EURC** 1:1, or in USDC at a rate quoted at checkout
  (15 minutes; the quote id rides in the memo as `q=…`). Reconciliation is in the invoice currency.
  A USDC payment without a valid quote is held (`fx_missing`) until the merchant accepts it at the
  current reference rate. Receipts show both amounts and the rate. USDC received on a EUR invoice can be
  converted to EURC from the invoice page with Circle's Swap Kit; an optional Clearmark fee on that swap
  is off unless `NEXT_PUBLIC_CLEARMARK_SWAP_FEE_BPS` and `NEXT_PUBLIC_CLEARMARK_FEE_RECIPIENT` are set.
  Reference rates come from the ECB via frankfurter.app, or pin one with `CLEARMARK_EUR_PER_USD`.

## How matching works

Each invoice gets a fingerprint `memoId = keccak256("clearmark:v1:invoice:<id>")`. The checkout pays
through Arc's predeployed **Memo contract** (`0x5294…e505`), which wraps the USDC `transfer` and emits
a `Memo` event carrying that fingerprint while preserving the payer as `msg.sender`. Clearmark ties the
`Memo` event to its exact `Transfer` by `callDataHash = keccak256(transfer calldata)`, so the match is
deterministic, not a guess. Payments arrive two ways:

1. **Instantly**: the checkout posts its tx hash to `/api/pay/:id/confirm`; the server re-reads the
   receipt from Arc and trusts nothing from the browser.
2. **Continuously**: while the dashboard is open, `/api/sync` scans new USDC `Transfer` logs to the
   merchant's address, so payments sent from exchanges or other wallets show up too.

Refunds are sent from the merchant's own wallet (Clearmark never has custody) with a refund memo, and
recorded only after the transfer is verified onchain.

## Code map

```
src/lib/engine.ts     reconciliation rules (pure, unit-tested)
src/lib/limits.ts     transaction limits (pure)
src/lib/matching.ts   suggestions for untagged transfers (pure)
src/lib/ledger.ts     ledger operations on the data model (pure)
src/lib/arc.ts        Arc mainnet config, Memo ABI, transfer + memo extraction
src/lib/chain.ts      server reads from Arc (verify tx, scan inbound)
src/lib/service.ts    use cases and views for the API
src/lib/store.ts      v1 JSON file store (swap for Postgres later; only this file changes)
src/lib/auth.ts       sign in with a wallet signature, HMAC session cookie
src/app/api/…         thin route handlers
src/app/app/…         merchant dashboard, review inbox, history, limits
src/app/pay/[id]      customer checkout
src/app/r/…           proof receipts
```

## Run it locally

```bash
cp .env.example .env.local     # set SESSION_SECRET; CLEARMARK_DEMO=1 lets you simulate payments
npm install
npm run dev                    # http://localhost:3000
npm test                       # reconciliation, limits, ledger and memo-extraction tests
```

Sign in with MetaMask or Rabby (a free signature, no transaction). With `CLEARMARK_DEMO=1`, every invoice
and checkout shows **Simulate payment** buttons that push fake transfers through the exact same
pipeline. Simulated payments are labelled everywhere and never touch the chain; turn demo mode off for
any shared deployment.

### Real payments

Open the invoice's payment link with a different wallet from the merchant's and pay. The payer needs the
invoice amount in USDC or EURC on Arc plus a little USDC for gas, or USDC on one of the eight supported
chains to bridge in. Full USDC and EURC payments on Arc go through the ClearmarkPay contracts
(USDC `0xEb73…af0b`, EURC `0x5de9…dDe8`); part, rate-quoted and bridged payments use Arc's Memo contract.

## Deploy to Vercel

1. Import the repo and set the **Production Branch** to the branch that holds the app (`Enoxx` once PR #1 is merged).
2. Add environment variables: `SESSION_SECRET` (any long random string), `CLEARMARK_PUBLIC_URL`
   (your site URL, for share cards) and, for demo buttons, `CLEARMARK_DEMO=1`.
3. In **Storage**, add **Upstash for Redis** and connect it to the project. It sets
   `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_*`), and Clearmark stores its data
   there. Without it the app still runs, but data lives in `/tmp` and disappears between requests.
4. Redeploy.

## Not in v1 yet

Gasless checkout (EIP-3009 relayer), recurring invoices, escrow, agent payments, team members (the
refund second approval is a signed confirmation by the merchant for now), applying customer credit to a
later invoice, email sending, PDF statements, and a real database. Native-token (18-decimal) USDC sends
are not detected; customers pay through the 6-decimal ERC-20 interface, which the checkout does.
