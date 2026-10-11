"use client";
// Browser wallet helpers. The wallet is picked and connected with ConnectKit (components/WalletProvider);
// these helpers then talk to that wallet's EIP-1193 provider. Keys never leave the wallet.

import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  numberToHex,
  publicActions,
  type EIP1193Provider,
} from "viem";
import {
  arc,
  ARC_CHAIN_ID,
  BATCHER_ADDRESS,
  batchTransferCalldata,
  CLEARMARK_PAY,
  clearmarkPayAbi,
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

export const browserClient = createPublicClient({ chain: arc, transport: http() });

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

/** Switch the wallet to Arc, adding the network if the wallet doesn't know it yet. */
export async function ensureArc() {
  const p = provider();
  const current = Number(await p.request({ method: "eth_chainId" }));
  if (current === ARC_CHAIN_ID) return;
  const chainId = numberToHex(ARC_CHAIN_ID);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Arc",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: arc.rpcUrls.default.http as unknown as string[],
          blockExplorerUrls: [arc.blockExplorers!.default.url],
        },
      ],
    });
  }
}

function wallet(account: Hex) {
  return createWalletClient({ account, chain: arc, transport: custom(provider()) });
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
  await ensureArc();
  return wallet(account).writeContract({
    account,
    address: MEMO_ADDRESS,
    abi: memoAbi,
    functionName: "memo",
    args: [TOKEN_ADDRESS[token], transferCalldata(to, amount), memoId, memoData],
  });
}

/**
 * Whether checkout can pay in `token` through the ClearmarkPay contract (it only accepts some tokens).
 * Asks through the connected wallet first (switched to Arc), then the public RPC. Returns null when
 * neither answers, so the caller can tell "the contract said no" apart from "couldn't ask".
 */
export async function contractAccepts(account: Hex, token: Token): Promise<boolean | null> {
  const pay = CLEARMARK_PAY[token];
  if (!pay) return false;
  const args = { address: pay, abi: clearmarkPayAbi, functionName: "isAllowedToken", args: [TOKEN_ADDRESS[token]] } as const;
  try {
    await ensureArc();
    return await wallet(account).extend(publicActions).readContract(args);
  } catch (e) {
    console.warn("[clearmark] contract check through the wallet failed", e);
  }
  try {
    return await browserClient.readContract(args);
  } catch (e) {
    console.warn("[clearmark] contract check through the public RPC failed", e);
    return null;
  }
}

/**
 * Pay an invoice through the ClearmarkPay contract. The payer first approves exactly `amount` (never an
 * unlimited allowance), skipped when an earlier approval still covers it, then calls payInvoice.
 */
export async function payViaContract(
  account: Hex,
  to: Hex,
  amount: bigint,
  invoiceId: Hex,
  token: Token,
  onStage: (s: string) => void = () => {},
): Promise<Hex> {
  const pay = CLEARMARK_PAY[token];
  if (!pay) throw new Error(`The Clearmark payment contract for ${token} isn't set up.`);
  await ensureArc();
  const tokenAddress = TOKEN_ADDRESS[token];
  const allowance = await chainReader()
    .readContract({ address: tokenAddress, abi: erc20Abi, functionName: "allowance", args: [account, pay] })
    .catch(() => 0n);
  if (allowance < amount) {
    onStage(`Step 1 of 2: allow Clearmark to send ${token} in your wallet…`);
    const approval = await wallet(account).writeContract({
      account,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [pay, amount],
    });
    onStage("Waiting for the approval to settle…");
    const r = await waitForTx(approval);
    if (r.status !== "success") throw new Error("The approval didn't go through. Nothing was paid.");
    onStage("Step 2 of 2: confirm the payment in your wallet…");
  }
  return wallet(account).writeContract({
    account,
    address: pay,
    abi: clearmarkPayAbi,
    functionName: "payInvoice",
    args: [tokenAddress, to, amount, invoiceId],
  });
}

/**
 * Pay several wallets in one atomic transaction through Arc's Multicall3From. Each transfer is
 * sent from the caller's own wallet (sender-preserving), so the batch stays non-custodial.
 */
export async function sendBatch(account: Hex, token: Token, transfers: { to: Hex; amount: bigint }[]): Promise<Hex> {
  await ensureArc();
  return wallet(account).sendTransaction({ account, to: BATCHER_ADDRESS, data: batchTransferCalldata(token, transfers) });
}

/**
 * Reads Arc through the connected wallet's own RPC first, then the public RPC. Some browsers can't
 * reach the public RPC (privacy extensions, network filters) while the wallet still can. Use it only
 * once the wallet is on Arc, e.g. after ensureArc or right after the wallet sent a transaction.
 */
function chainReader() {
  const p = active ?? (typeof window !== "undefined" ? window.ethereum : undefined);
  if (!p) return browserClient;
  return createPublicClient({ chain: arc, transport: fallback([custom(p), http()]) });
}

export async function waitForTx(hash: Hex) {
  return chainReader().waitForTransactionReceipt({ hash, timeout: 90_000 });
}

export function friendlyError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err?.code === 4001 || /rejected|denied/i.test(err?.message ?? "")) return "You cancelled the request in your wallet.";
  if (/insufficient/i.test(err?.message ?? "")) return "Not enough funds in this wallet. Paying needs the invoice amount plus a little USDC for gas on Arc.";
  return err?.shortMessage ?? err?.message?.split("\n")[0] ?? "Something went wrong.";
}
