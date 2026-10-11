// Server-side reads from Arc mainnet: verify a single transaction, or scan for new
// inbound USDC transfers to a merchant since the last sync.

import "server-only";
import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import { arc, ARC_CHAIN_ID, EURC_ADDRESS, extractTransfers, USDC_ADDRESS, type ExtractedTransfer } from "./arc";
import type { Hex } from "./types";

const RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";

export const client = createPublicClient({ chain: arc, transport: http(RPC, { timeout: 15_000 }) });

let chainChecked = false;
/** Refuse to run against anything but Arc mainnet. */
export async function assertArc() {
  if (chainChecked) return;
  const id = await client.getChainId();
  if (id !== ARC_CHAIN_ID) {
    throw new Error(`ARC_RPC_URL points at chain ${id}. Clearmark only runs on Arc mainnet (${ARC_CHAIN_ID}).`);
  }
  chainChecked = true;
}

export async function latestBlock(): Promise<bigint> {
  await assertArc();
  return client.getBlockNumber();
}

const blockTimes = new Map<bigint, string>();
export async function blockTime(n: bigint): Promise<string> {
  const hit = blockTimes.get(n);
  if (hit) return hit;
  const b = await client.getBlock({ blockNumber: n });
  const iso = new Date(Number(b.timestamp) * 1000).toISOString();
  if (blockTimes.size > 5000) blockTimes.clear();
  blockTimes.set(n, iso);
  return iso;
}

export interface VerifiedTx {
  status: "success" | "reverted";
  blockNumber: bigint;
  timestamp: string;
  transfers: ExtractedTransfer[];
}

/** Read a transaction's receipt and pull out its USDC transfers and memos. */
export async function verifyTx(hash: Hex): Promise<VerifiedTx | null> {
  await assertArc();
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return null;
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    timestamp: await blockTime(receipt.blockNumber),
    transfers: receipt.status === "success" ? extractTransfers(receipt.logs as Log[], hash) : [],
  };
}

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CHUNK = 5_000n;
const MAX_BLOCKS_PER_SYNC = 50_000n;

/**
 * Find inbound USDC and EURC transfers to `merchant` in (fromBlock, toBlock], and resolve each one's memo
 * by reading its transaction receipt. Bounded per call so a long gap catches up over several syncs.
 */
export async function scanInbound(merchant: Hex, after: bigint) {
  await assertArc();
  const head = await client.getBlockNumber();
  const to = head - after > MAX_BLOCKS_PER_SYNC ? after + MAX_BLOCKS_PER_SYNC : head;
  const out: (ExtractedTransfer & { timestamp: string })[] = [];
  const seenTx = new Set<string>();
  for (let start = after + 1n; start <= to; start += CHUNK) {
    const end = start + CHUNK - 1n > to ? to : start + CHUNK - 1n;
    const logs = await client.getLogs({ address: [USDC_ADDRESS, EURC_ADDRESS], event: transferEvent, args: { to: merchant }, fromBlock: start, toBlock: end });
    for (const log of logs) {
      if (!log.transactionHash || seenTx.has(log.transactionHash)) continue;
      seenTx.add(log.transactionHash);
      const v = await verifyTx(log.transactionHash);
      if (!v) continue;
      for (const t of v.transfers) if (t.to === merchant.toLowerCase()) out.push({ ...t, timestamp: v.timestamp });
    }
  }
  return { transfers: out, syncedTo: to, head };
}
