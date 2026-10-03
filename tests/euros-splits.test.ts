import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, type Log } from "viem";
import {
  BATCHER_ADDRESS,
  batcherAbi,
  batchTransferCalldata,
  erc20Abi,
  EURC_ADDRESS,
  extractTransfers,
  invoiceMemoId,
  memoAbi,
  memoText,
  MEMO_ADDRESS,
  transferCalldata,
  USDC_ADDRESS,
} from "@/lib/arc";
import { paymentValue, toInvoiceUnits, toTokenUnits } from "@/lib/fx";
import {
  createInvoice,
  createPayout,
  createQuote,
  createRefund,
  ensureMerchant,
  invoiceState,
  markPayoutSent,
  markRefundSent,
  parseSplits,
  payoutPlan,
  QUOTE_TTL_MS,
  recordTransfer,
  resolveHold,
  unconvertedUsdc,
} from "@/lib/ledger";
import { toUnits } from "@/lib/money";
import type { Db, Hex } from "@/lib/types";

const M = "0x4f2c000000000000000000000000000000091ae0" as Hex;
const PAYER = "0x9a1d00000000000000000000000000000000c07b" as Hex;
const ANA = "0xa11a000000000000000000000000000000000001" as Hex;
const BO = "0xb0b0000000000000000000000000000000000002" as Hex;
const now = new Date("2026-09-28T12:00:00Z");
const fresh = (): Db => ({ version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });
const RATE = 920_000n; // 1 USDC = 0.92 EUR

let tx = 0;
function pay(db: Db, memoId: Hex | null, amount: string, token: "USDC" | "EURC", fields: Record<string, string> = {}, at = now) {
  return recordTransfer(
    db,
    {
      source: "demo",
      txHash: `0x${(++tx).toString(16).padStart(64, "0")}` as Hex,
      logIndex: 0,
      blockNumber: BigInt(tx),
      timestamp: at.toISOString(),
      from: PAYER,
      to: M,
      amount: toUnits(amount),
      memoId,
      memoData: memoText({ pay: "full", ...fields }),
      token,
    },
    at,
  )!;
}

function eurInvoice(amount = "460") {
  const db = fresh();
  ensureMerchant(db, M, now, 1n);
  const inv = createInvoice(db, M, { title: "Brand kit", customerName: "Lumen GmbH", amount, dueDate: "2026-10-30", currency: "EUR" }, now);
  return { db, inv };
}

describe("fx maths", () => {
  it("rounds in the merchant's favour both ways", () => {
    expect(toTokenUnits(toUnits("460"), RATE)).toBe(toUnits("500"));
    expect(toTokenUnits(1n, RATE)).toBe(2n); // never short
    expect(toInvoiceUnits(toUnits("500"), RATE)).toBe(toUnits("460"));
    expect(toInvoiceUnits(toTokenUnits(toUnits("123.45"), 917_331n), 917_331n) >= toUnits("123.45")).toBe(true);
  });

  it("values a same-currency payment 1:1 and a quoted one at its rate", () => {
    expect(paymentValue({ currency: "EUR" }, { amount: "1000000", token: "EURC", fx: null })).toBe(1_000_000n);
    expect(paymentValue({ currency: "EUR" }, { amount: "1000000", token: "USDC", fx: { rate: "920000", quoteId: "q", source: "x" } })).toBe(920_000n);
    expect(paymentValue({}, { amount: "1000000", token: "USDC", fx: null })).toBe(1_000_000n);
  });
});

describe("euro invoices", () => {
  it("settles 1:1 in EURC", () => {
    const { db, inv } = eurInvoice();
    pay(db, inv.memoId, "460", "EURC");
    const st = invoiceState(db, inv, now);
    expect(st.status).toBe("paid");
    expect(unconvertedUsdc(db, inv)).toBe(0n);
  });

  it("settles in USDC at the quoted rate when the memo carries the quote", () => {
    const { db, inv } = eurInvoice();
    const q = createQuote(db, inv.id, toUnits("460"), RATE, "test", now);
    expect(q.usdc).toBe(toUnits("500").toString());
    const p = pay(db, inv.memoId, "500", "USDC", { q: q.id });
    expect(p.fx?.rate).toBe("920000");
    expect(p.hold).toBeNull();
    expect(invoiceState(db, inv, now).status).toBe("paid");
    expect(unconvertedUsdc(db, inv)).toBe(toUnits("500"));
  });

  it("holds a USDC payment with no quote, then counts it at the rate the merchant accepts", () => {
    const { db, inv } = eurInvoice();
    const p = pay(db, inv.memoId, "500", "USDC");
    expect(p.hold?.reason).toBe("fx_missing");
    expect(invoiceState(db, inv, now).status).toBe("open");
    expect(() => resolveHold(db, M, p.id, "accept", now, null)).toThrow(/rate/);
    resolveHold(db, M, p.id, "accept", now, { rate: RATE, source: "ecb" });
    expect(invoiceState(db, inv, now).status).toBe("paid");
  });

  it("treats an expired quote as missing", () => {
    const { db, inv } = eurInvoice();
    const q = createQuote(db, inv.id, toUnits("460"), RATE, "test", now);
    const late = new Date(now.getTime() + QUOTE_TTL_MS + 60 * 60_000);
    expect(pay(db, inv.memoId, "500", "USDC", { q: q.id }, late).hold?.reason).toBe("fx_missing");
  });

  it("won't quote a USDC invoice", () => {
    const db = fresh();
    ensureMerchant(db, M, now, 1n);
    const inv = createInvoice(db, M, { title: "x", customerName: "y", amount: "10", dueDate: "2026-10-30" }, now);
    expect(() => createQuote(db, inv.id, 1n, RATE, "t", now)).toThrow(/USDC/);
  });

  it("refunds an overpayment in the token the payer sent, sized from invoice units", () => {
    const { db, inv } = eurInvoice();
    const q = createQuote(db, inv.id, toUnits("460"), RATE, "test", now);
    const p = pay(db, inv.memoId, "600", "USDC", { q: q.id }); // worth 552 EUR, 92 EUR over
    expect(invoiceState(db, inv, now).status).toBe("overpaid");
    const r = createRefund(db, M, p.id, null, "overpayment", now);
    expect(r.token).toBe("USDC");
    expect(r.invoiceUnits).toBe(toUnits("92").toString());
    expect(r.amount).toBe(toUnits("100").toString());
    expect(() => markRefundSent(db, M, r.id, { txHash: "0x01", blockNumber: 1n, timestamp: now.toISOString(), from: M, to: PAYER, amount: toUnits("100"), memoId: null, token: "EURC" })).toThrow(/EURC/);
    markRefundSent(db, M, r.id, { txHash: "0x01", blockNumber: 1n, timestamp: now.toISOString(), from: M, to: PAYER, amount: toUnits("100"), memoId: null, token: "USDC" });
    expect(invoiceState(db, inv, now).status).toBe("paid");
  });
});

describe("Payday Splits", () => {
  it("validates collaborators", () => {
    expect(parseSplits([{ label: "Ana", address: ANA, pct: "30" }], M)).toEqual([{ label: "Ana", address: ANA, bps: 3000 }]);
    expect(() => parseSplits([{ label: "Me", address: M, pct: "10" }], M)).toThrow(/own wallet/);
    expect(() => parseSplits([{ label: "Ana", address: "0x123", pct: "10" }], M)).toThrow(/valid wallet/);
    expect(() => parseSplits([{ label: "A", address: ANA, pct: "10" }, { label: "B", address: ANA, pct: "10" }], M)).toThrow(/already/);
    expect(() => parseSplits([{ label: "A", address: ANA, pct: "60" }, { label: "B", address: BO, pct: "50" }], M)).toThrow(/110%/);
    expect(() => parseSplits([{ label: "A", address: ANA, pct: "0" }], M)).toThrow(/above 0/);
  });

  function splitInvoice() {
    const db = fresh();
    ensureMerchant(db, M, now, 1n);
    const inv = createInvoice(
      db,
      M,
      { title: "Launch site", customerName: "Acme", amount: "1000", dueDate: "2026-10-30", splits: [{ label: "Ana", address: ANA, pct: "30" }, { label: "Bo", address: BO, pct: "12.5" }] },
      now,
    );
    return { db, inv };
  }

  it("pays shares of what the invoice settled for, once it is paid", () => {
    const { db, inv } = splitInvoice();
    expect(() => createPayout(db, M, inv.id, now)).toThrow(/fully paid/);
    pay(db, inv.memoId, "1200", "USDC"); // overpaid: shares are on the 1000 price, not 1200
    const plan = payoutPlan(db, inv, now);
    expect(plan.base).toBe(toUnits("1000"));
    const po = createPayout(db, M, inv.id, now);
    expect(po.lines.map((l) => l.amount)).toEqual([toUnits("300").toString(), toUnits("125").toString()]);
    expect(createPayout(db, M, inv.id, now).id).toBe(po.id); // one per invoice
  });

  it("only marks a payout sent when every share left the merchant's wallet exactly", () => {
    const { db, inv } = splitInvoice();
    pay(db, inv.memoId, "1000", "USDC");
    const po = createPayout(db, M, inv.id, now);
    const base = { txHash: "0xbeef" as Hex, blockNumber: 9n, timestamp: now.toISOString() };
    const good = [
      { from: M, to: ANA, amount: toUnits("300"), token: "USDC" as const },
      { from: M, to: BO, amount: toUnits("125"), token: "USDC" as const },
    ];
    expect(() => markPayoutSent(db, M, po.id, { ...base, transfers: [good[0]] })).toThrow(/Bo/);
    expect(() => markPayoutSent(db, M, po.id, { ...base, transfers: [good[0], { ...good[1], from: PAYER }] })).toThrow(/Bo/);
    expect(() => markPayoutSent(db, M, po.id, { ...base, transfers: [good[0], { ...good[1], token: "EURC" }] })).toThrow(/Bo/);
    expect(markPayoutSent(db, M, po.id, { ...base, transfers: good }).status).toBe("sent");
  });

  it("encodes one Multicall3From batch of token transfers", () => {
    const data = batchTransferCalldata("EURC", [{ to: ANA, amount: 5n }, { to: BO, amount: 7n }]);
    const { functionName, args } = decodeFunctionData({ abi: batcherAbi, data });
    expect(functionName).toBe("aggregate3");
    const calls = args[0] as readonly { target: Hex; allowFailure: boolean; callData: Hex }[];
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.target === EURC_ADDRESS && c.allowFailure === false)).toBe(true);
    expect(calls[1].callData).toBe(transferCalldata(BO, 7n));
    expect(BATCHER_ADDRESS).toMatch(/^0x522f/i);
  });
});

describe("extractTransfers with EURC", () => {
  it("tags a EURC transfer and pairs the memo only with the matching token", () => {
    const memoId = invoiceMemoId("eur");
    const amount = toUnits("460");
    const eurcLog = {
      address: EURC_ADDRESS,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER, to: M } }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
      logIndex: 1,
      blockNumber: 5n,
    } as unknown as Log;
    // A USDC transfer with identical calldata in the same tx must not steal the EURC memo.
    const usdcLog = { ...eurcLog, address: USDC_ADDRESS, logIndex: 0 } as unknown as Log;
    const memoLog = {
      address: MEMO_ADDRESS,
      topics: encodeEventTopics({ abi: memoAbi, eventName: "Memo", args: { sender: PAYER, target: EURC_ADDRESS, memoId } }),
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }], [keccak256(transferCalldata(M, amount)), memoText({ pay: "full" }), 1n]),
      logIndex: 2,
      blockNumber: 5n,
    } as unknown as Log;
    const out = extractTransfers([usdcLog, eurcLog, memoLog], "0xab");
    const u = out.find((t) => t.token === "USDC")!;
    const e = out.find((t) => t.token === "EURC")!;
    expect(u.memoId).toBeNull();
    expect(e.memoId).toBe(memoId);
  });
});
