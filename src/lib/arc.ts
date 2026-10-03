// Arc TESTNET configuration and the onchain primitives Clearmark uses.
// Safe to import from both server and browser code.

import {
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  hexToString,
  type Log,
} from "viem";
import type { Hex } from "./types";

export const ARC_TESTNET_CHAIN_ID = 5042002;

// NEXT_PUBLIC_* values are inlined into the browser bundle at build time.
const rpc = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.io";

export const EXPLORER_URL = process.env.NEXT_PUBLIC_ARC_EXPLORER_URL || "https://explorer.testnet.arc.io";

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  // Native USDC is the gas token and uses 18 decimals. Payments use the 6-decimal ERC-20 interface.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
  blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER_URL } },
  testnet: true,
});

/** USDC ERC-20 interface on Arc testnet (6 decimals). */
export const USDC_ADDRESS: Hex = "0x3600000000000000000000000000000000000000";
/** Arc's predeployed Memo contract. Preserves msg.sender for the wrapped call. */
export const MEMO_ADDRESS: Hex = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "event BeforeMemo(uint256 indexed memoIndex)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
]);

export { erc20Abi };

/** The invoice fingerprint written onchain. Derived from the invoice's random public id. */
export function invoiceMemoId(invoiceId: string): Hex {
  return keccak256(stringToHex(`clearmark:v1:invoice:${invoiceId}`));
}

export function refundMemoId(refundId: string): Hex {
  return keccak256(stringToHex(`clearmark:v1:refund:${refundId}`));
}

/** Human-readable memo bytes: short, no personal data (it is public forever). */
export function memoText(fields: Record<string, string>): Hex {
  return stringToHex("cm1;" + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(";"));
}

export function parseMemoText(hex: Hex | null): { text: string | null; fields: Record<string, string> } {
  if (!hex || hex === "0x") return { text: null, fields: {} };
  let text: string;
  try {
    text = hexToString(hex);
  } catch {
    return { text: null, fields: {} };
  }
  const fields: Record<string, string> = {};
  if (text.startsWith("cm1;")) {
    for (const kv of text.slice(4).split(";")) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) fields[k] = v;
    }
  }
  return { text, fields };
}

export function transferCalldata(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}

/** Calldata for Memo.memo(USDC, transfer(to, amount), memoId, memoData). */
export function memoTransferCalldata(to: Hex, amount: bigint, memoId: Hex, memoData: Hex): Hex {
  return encodeFunctionData({
    abi: memoAbi,
    functionName: "memo",
    args: [USDC_ADDRESS, transferCalldata(to, amount), memoId, memoData],
  });
}

export interface ExtractedTransfer {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  from: Hex;
  to: Hex;
  amount: bigint;
  memoId: Hex | null;
  memoData: Hex | null;
}

/**
 * Pull every USDC transfer out of a transaction's logs and attach the Memo that wrapped it,
 * if any. A Memo is tied to its transfer by callDataHash = keccak256(transfer calldata).
 */
export function extractTransfers(logs: Log[], txHash: Hex): ExtractedTransfer[] {
  const memos: { callDataHash: Hex; memoId: Hex; memo: Hex; used: boolean }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== MEMO_ADDRESS.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: memoAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Memo" && ev.args.target.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
        memos.push({ callDataHash: ev.args.callDataHash, memoId: ev.args.memoId, memo: ev.args.memo, used: false });
      }
    } catch {
      /* not a Memo event */
    }
  }
  const out: ExtractedTransfer[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (ev.eventName !== "Transfer") continue;
    const { from, to, value } = ev.args;
    const hash = keccak256(transferCalldata(getAddress(to), value));
    const memo = memos.find((m) => !m.used && m.callDataHash === hash);
    if (memo) memo.used = true;
    out.push({
      txHash,
      logIndex: log.logIndex ?? 0,
      blockNumber: log.blockNumber ?? 0n,
      from: from.toLowerCase() as Hex,
      to: to.toLowerCase() as Hex,
      amount: value,
      memoId: memo?.memoId ?? null,
      memoData: memo?.memo ?? null,
    });
  }
  return out;
}

export const shortHex = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);
export const txUrl = (h: string) => `${EXPLORER_URL}/tx/${h}`;
export const addressUrl = (a: string) => `${EXPLORER_URL}/address/${a}`;
