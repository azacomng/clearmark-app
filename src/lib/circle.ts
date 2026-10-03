"use client";
// Circle App Kit pieces, loaded only when a payer or merchant uses them (they are large).
//   Bridge Kit: move USDC from another chain to the payer's own wallet on Arc (CCTP v2).
//   Swap Kit:   convert USDC to EURC on Arc from the merchant's own wallet.
// Both run against the user's injected wallet; Clearmark never holds keys or funds.

import type { Hex } from "./types";

/** Testnets the payer can bring USDC from. Names are Bridge Kit chain identifiers. */
export const SOURCE_CHAINS = [
  { id: "Base_Sepolia", label: "Base Sepolia" },
  { id: "Ethereum_Sepolia", label: "Ethereum Sepolia" },
  { id: "Arbitrum_Sepolia", label: "Arbitrum Sepolia" },
  { id: "Optimism_Sepolia", label: "OP Sepolia" },
  { id: "Avalanche_Fuji", label: "Avalanche Fuji" },
  { id: "Polygon_Amoy_Testnet", label: "Polygon Amoy" },
  { id: "Unichain_Sepolia", label: "Unichain Sepolia" },
  { id: "Linea_Sepolia", label: "Linea Sepolia" },
] as const;
export type SourceChain = (typeof SOURCE_CHAINS)[number]["id"];

async function adapter() {
  if (!window.ethereum) throw new Error("No wallet found. Open this link in a browser with MetaMask or Rabby.");
  const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
  return createViemAdapterFromProvider({ provider: window.ethereum, capabilities: { addressContext: "user-controlled" } });
}

const usd = (units: bigint) => (Number(units) / 1e6).toFixed(6).replace(/\.?0+$/, "");

/** Estimated fees (in USDC units) for bridging `amount` from `chain` to the payer's wallet on Arc. */
export async function estimateBridge(chain: SourceChain, recipient: Hex, amount: bigint): Promise<bigint> {
  const { BridgeKit } = await import("@circle-fin/bridge-kit");
  const kit = new BridgeKit();
  const est = await kit.estimate({
    from: { adapter: await adapter(), chain },
    to: { chain: "Arc_Testnet", recipientAddress: recipient, useForwarder: true },
    amount: usd(amount),
  });
  return est.fees.reduce((t, f) => t + (f.amount ? BigInt(Math.ceil(Number(f.amount) * 1e6)) : 0n), 0n);
}

/**
 * Bridge USDC from `chain` to the payer's own address on Arc. Circle's Forwarder submits the mint
 * on Arc, so the payer needs no Arc gas for this step. Resolves once the mint is confirmed.
 */
export async function bridgeToArc(chain: SourceChain, recipient: Hex, amount: bigint, onStep: (s: string) => void) {
  const { BridgeKit } = await import("@circle-fin/bridge-kit");
  const kit = new BridgeKit();
  const names: Record<string, string> = {
    approve: "Approving USDC on the source chain…",
    burn: "Sending USDC into Circle's bridge…",
    fetchAttestation: "Waiting for Circle to attest the transfer…",
    mint: "Minting USDC to your wallet on Arc…",
  };
  kit.on("*", (e: { method?: string }) => {
    if (e.method && names[e.method]) onStep(names[e.method]);
  });
  const res = await kit.bridge({
    from: { adapter: await adapter(), chain },
    to: { chain: "Arc_Testnet", recipientAddress: recipient, useForwarder: true },
    amount: usd(amount),
  });
  if (res.state === "error") throw new Error("The bridge transfer failed. Your USDC is still on the source chain, or check your wallet history.");
  return res;
}

/** Optional Clearmark fee on conversions, off unless both settings are present. */
function swapFee() {
  const bps = Number(process.env.NEXT_PUBLIC_CLEARMARK_SWAP_FEE_BPS || 0);
  const to = process.env.NEXT_PUBLIC_CLEARMARK_FEE_RECIPIENT;
  return bps > 0 && bps <= 100 && to ? { percentageBps: bps, recipientAddress: to } : undefined;
}

export const swapFeeBps = () => swapFee()?.percentageBps ?? 0;

/** Swap `amount` USDC to EURC on Arc from the merchant's wallet. Returns the swap's tx hash. */
export async function swapUsdcToEurc(amount: bigint, onStep: (s: string) => void): Promise<{ txHash: Hex; estimated: string | null }> {
  const { SwapKit } = await import("@circle-fin/swap-kit");
  const kit = new SwapKit();
  const params = {
    from: { adapter: await adapter(), chain: "Arc_Testnet" as const },
    tokenIn: "USDC" as const,
    tokenOut: "EURC" as const,
    amountIn: usd(amount),
    config: { slippageBps: 100, ...(swapFee() ? { customFee: swapFee()! } : {}) },
  };
  onStep("Getting a quote…");
  const est = await kit.estimate(params);
  onStep("Confirm the swap in your wallet…");
  const res = await kit.swap(params);
  return { txHash: res.txHash as Hex, estimated: est.estimatedOutput?.amount ?? null };
}
