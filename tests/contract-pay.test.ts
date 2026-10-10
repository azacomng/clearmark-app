import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { CLEARMARK_PAY_ADDRESS, clearmarkPayAbi, erc20Abi, extractTransfers, invoiceMemoId, USDC_ADDRESS } from "@/lib/arc";
import { toUnits } from "@/lib/money";
import type { Hex } from "@/lib/types";

const PAYER = "0x00000000000000000000000000000000000000aa" as Hex;
const M = "0x00000000000000000000000000000000000000bb" as Hex;
const OTHER = "0x00000000000000000000000000000000000000cc" as Hex;

function transferLog(from: Hex, to: Hex, amount: bigint, logIndex: number): Log {
  return {
    address: USDC_ADDRESS,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    logIndex,
    blockNumber: 7n,
  } as unknown as Log;
}

function paidLog(invoiceId: Hex, payer: Hex, merchant: Hex, amount: bigint, logIndex: number, address: Hex = CLEARMARK_PAY_ADDRESS!): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: clearmarkPayAbi, eventName: "InvoicePaid", args: { invoiceId, payer, merchant } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [USDC_ADDRESS, amount]),
    logIndex,
    blockNumber: 7n,
  } as unknown as Log;
}

describe("ClearmarkPay contract payments", () => {
  it("uses the deployed testnet contract by default", () => {
    expect(CLEARMARK_PAY_ADDRESS?.toLowerCase()).toBe("0x5de9f147cfc0406d1f23b3a2eedfc8cf133dfde8");
  });

  it("tags the transfer with the invoice from InvoicePaid", () => {
    const invoiceId = invoiceMemoId("inv1");
    const amount = toUnits("250");
    const out = extractTransfers([transferLog(PAYER, M, amount, 0), paidLog(invoiceId, PAYER, M, amount, 1)], "0xab");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: PAYER, to: M, amount, memoId: invoiceId, memoData: null, token: "USDC" });
  });

  it("ignores InvoicePaid events from any other contract", () => {
    const amount = toUnits("250");
    const fake = paidLog(invoiceMemoId("inv1"), PAYER, M, amount, 1, OTHER);
    const out = extractTransfers([transferLog(PAYER, M, amount, 0), fake], "0xab");
    expect(out[0].memoId).toBeNull();
  });

  it("only pairs the event with the transfer it describes", () => {
    const invoiceId = invoiceMemoId("inv2");
    const out = extractTransfers(
      [transferLog(PAYER, M, toUnits("10"), 0), transferLog(PAYER, M, toUnits("90"), 1), paidLog(invoiceId, PAYER, M, toUnits("90"), 2)],
      "0xab",
    );
    expect(out.find((t) => t.amount === toUnits("10"))!.memoId).toBeNull();
    expect(out.find((t) => t.amount === toUnits("90"))!.memoId).toBe(invoiceId);
  });

  it("pairs each of two identical payments in one transaction with its own event", () => {
    const a = invoiceMemoId("a");
    const b = invoiceMemoId("b");
    const amt = toUnits("5");
    const out = extractTransfers([transferLog(PAYER, M, amt, 0), paidLog(a, PAYER, M, amt, 1), transferLog(PAYER, M, amt, 2), paidLog(b, PAYER, M, amt, 3)], "0xab");
    expect(out.map((t) => t.memoId).sort()).toEqual([a, b].sort());
  });
});
