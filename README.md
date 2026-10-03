# Clearmark

**Every USDC payment, proven and matched.** Clearmark is invoice verification and automatic
reconciliation for USDC on [Arc](https://docs.arc.io). A merchant sends an invoice, the customer pays
from any wallet, and every transfer lands on the right invoice with a status a human can read.

Not a wallet, not a processor, and it never holds funds: payments go straight to the merchant's wallet.

> **v1 runs on Arc testnet only.** The server refuses to start syncing against any other chain id.

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
src/lib/arc.ts        Arc testnet config, Memo ABI, transfer + memo extraction
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

### Real testnet payments

1. Get testnet USDC from [faucet.circle.com](https://faucet.circle.com) (Arc testnet) for a customer wallet.
2. Open the invoice's payment link and pay with the wallet, or from the command line with a
   **throwaway** key:

```bash
TEST_PAYER_PRIVATE_KEY=0x… npm run send-test-payment -- http://localhost:3000/pay/<id>            # exact
TEST_PAYER_PRIVATE_KEY=0x… npm run send-test-payment -- http://localhost:3000/pay/<id> 200         # underpay
TEST_PAYER_PRIVATE_KEY=0x… npm run send-test-payment -- http://localhost:3000/pay/<id> 125 part    # split
TEST_PAYER_PRIVATE_KEY=0x… npm run send-test-payment -- http://localhost:3000/pay/<id> 250 full --untagged
```

## Not in v1 yet

Gasless checkout (EIP-3009 relayer), recurring invoices, escrow, agent payments, team members (the
refund second approval is a signed confirmation by the merchant for now), applying customer credit to a
later invoice, email sending, PDF statements, and a real database. Native-token (18-decimal) USDC sends
are not detected; customers pay through the 6-decimal ERC-20 interface, which the checkout does.
