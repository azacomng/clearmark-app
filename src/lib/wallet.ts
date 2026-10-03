"use client";
// Browser wallet helpers. The wallet is picked and connected with ConnectKit (components/WalletProvider);
// these helpers then talk to that wallet's EIP-1193 provider. Keys never leave the wallet.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  numberToHex,
  type EIP1193Provider,
} from "viem";
import {
  arcTestnet,
  ARC_TESTNET_CHAIN_ID,
  BATCHER_ADDRESS,
  batchTransferCalldata,
  erc20Abi,
  memoAbi,
  MEMO_ADDRESS,
  TOKEN_ADDRESS,
  transferCalldata,
  USDC_ADDRESS,
  type Token,
} from "./arc";
import type { Hex } from "./types";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export const browserClient = createPublicClient({ chain: arcTestnet, transport: http() });

let active: EIP1193Provider | null = null;

/** Set by the ConnectKit bridge whenever the connected wallet changes. */
export function setActiveProvider(p: EIP1193Provider | null) {
  active = p;
}

export function hasWallet() {
  return !!active || (typeof window !== "undefined" && !!window.ethereum);
}

/** The connected wallet's provider (ConnectKit), falling back to the injected one. */
export function walletProvider(): EIP1193Provider {
  const p = active ?? (typeof window !== "undefined" ? window.ethereum : undefined);
  if (!p) throw new Error("No wallet connected. Connect a wallet to continue.");
  return p;
}
const provider = walletProvider;

export async function connect(): Promise<Hex> {
  const [a] = (await provider().request({ method: "eth_requestAccounts" })) as Hex[];
  if (!a) throw new Error("No account selected in your wallet.");
  return a.toLowerCase() as Hex;
}

/** Switch the wallet to Arc testnet, adding the network if the wallet doesn't know it yet. */
export async function ensureArcTestnet() {
  const p = provider();
  const current = Number(await p.request({ method: "eth_chainId" }));
  if (current === ARC_TESTNET_CHAIN_ID) return;
  const chainId = numberToHex(ARC_TESTNET_CHAIN_ID);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Arc Testnet",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: arcTestnet.rpcUrls.default.http as unknown as string[],
          blockExplorerUrls: [arcTestnet.blockExplorers!.default.url],
        },
      ],
    });
  }
}

function wallet(account: Hex) {
  return createWalletClient({ account, chain: arcTestnet, transport: custom(provider()) });
}

export async function signText(account: Hex, message: string): Promise<Hex> {
  return wallet(account).signMessage({ account, message });
}

export async function usdcBalance(address: Hex): Promise<bigint> {
  return browserClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

export async function tokenBalance(address: Hex, token: Token): Promise<bigint> {
  return browserClient.readContract({ address: TOKEN_ADDRESS[token], abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

/** Send USDC or EURC to `to` through Arc's Memo contract so the transfer carries the invoice fingerprint. */
export async function sendWithMemo(account: Hex, to: Hex, amount: bigint, memoId: Hex, memoData: Hex, token: Token = "USDC"): Promise<Hex> {
  await ensureArcTestnet();
  return wallet(account).writeContract({
    account,
    address: MEMO_ADDRESS,
    abi: memoAbi,
    functionName: "memo",
    args: [TOKEN_ADDRESS[token], transferCalldata(to, amount), memoId, memoData],
  });
}

/**
 * Pay several wallets in one atomic transaction through Arc's Multicall3From. Each transfer is
 * sent from the caller's own wallet (sender-preserving), so the batch stays non-custodial.
 */
export async function sendBatch(account: Hex, token: Token, transfers: { to: Hex; amount: bigint }[]): Promise<Hex> {
  await ensureArcTestnet();
  return wallet(account).sendTransaction({ account, to: BATCHER_ADDRESS, data: batchTransferCalldata(token, transfers) });
}

export async function waitForTx(hash: Hex) {
  return browserClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

export function friendlyError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err?.code === 4001 || /rejected|denied/i.test(err?.message ?? "")) return "You cancelled the request in your wallet.";
  if (/insufficient/i.test(err?.message ?? "")) return "Not enough USDC in this wallet. Get testnet USDC from faucet.circle.com.";
  return err?.shortMessage ?? err?.message?.split("\n")[0] ?? "Something went wrong.";
}
