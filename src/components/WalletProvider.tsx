"use client";

// Wallet connection through ConnectKit + wagmi (per docs.arc.io "Connect to Arc"). ConnectKit only picks
// and connects the wallet; signing and payments still go through src/lib/wallet.ts on the connected provider.

import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider, getDefaultConfig, useModal } from "connectkit";
import { createConfig, http, useAccount, WagmiProvider } from "wagmi";
import { mainnet } from "viem/chains";
import type { EIP1193Provider } from "viem";
import { arcTestnet } from "@/lib/arc";
import { setActiveProvider } from "@/lib/wallet";

const config = createConfig(
  getDefaultConfig({
    // Arc testnet first so it is the default. Mainnet is only here so ConnectKit's ENS lookups use a
    // CORS-safe endpoint instead of its own, as the Arc docs recommend.
    chains: [arcTestnet, mainnet],
    transports: {
      [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
      [mainnet.id]: http("https://cloudflare-eth.com"),
    },
    walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
    appName: "Clearmark",
    enableAaveAccount: false,
    // Coinbase Wallet's SDK otherwise loads an analytics script that pings cca-lite.coinbase.com; when an
    // ad blocker stops it, the dev overlay shows "Failed to fetch". Clearmark doesn't need it.
    coinbaseWalletPreference: { options: "all", telemetry: false },
    appDescription: "Every USDC payment, proven and matched.",
    ssr: true,
  }),
);

/** Hands the connected wallet's EIP-1193 provider to lib/wallet so the existing flows use it. */
function Bridge() {
  const { connector, isConnected } = useAccount();
  useEffect(() => {
    let live = true;
    if (!isConnected || !connector) {
      setActiveProvider(null);
      return;
    }
    connector
      .getProvider()
      .then((p) => live && setActiveProvider(p as EIP1193Provider))
      .catch(() => live && setActiveProvider(null));
    return () => {
      live = false;
    };
  }, [connector, isConnected]);
  return null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="midnight"
          mode="dark"
          customTheme={{
            "--ck-font-family": '"Geist", "Inter", system-ui, sans-serif',
            "--ck-border-radius": "20px",
            "--ck-overlay-background": "rgba(5,6,14,.6)",
            "--ck-overlay-backdrop-filter": "blur(10px)",
            "--ck-body-background": "#0B0E1F",
            "--ck-body-background-secondary": "rgba(255,255,255,.05)",
            "--ck-body-background-tertiary": "rgba(255,255,255,.08)",
            "--ck-primary-button-background": "rgba(255,255,255,.05)",
            "--ck-primary-button-hover-background": "rgba(139,157,255,.16)",
            "--ck-accent-color": "#8B9DFF",
            "--ck-accent-text-color": "#070A1A",
          }}
          options={{ initialChainId: arcTestnet.id, enforceSupportedChains: false, hideNoWalletCTA: false }}
        >
          <Bridge />
          {children}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * Returns a function that resolves once a wallet is connected, opening the ConnectKit picker first
 * if needed. Rejects if the picker is closed without connecting.
 */
export function useConnectWallet() {
  const { isConnected, connector } = useAccount();
  const { open, setOpen } = useModal();
  const waiter = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  useEffect(() => {
    if (!isConnected || !connector || !waiter.current) return;
    const w = waiter.current;
    waiter.current = null;
    connector
      .getProvider()
      .then((p) => {
        setActiveProvider(p as EIP1193Provider);
        setOpen(false);
        w.resolve();
      })
      .catch((e: Error) => w.reject(e));
  }, [isConnected, connector, setOpen]);

  useEffect(() => {
    if (open || !waiter.current) return;
    const t = setTimeout(() => {
      if (!waiter.current) return;
      waiter.current.reject(Object.assign(new Error("You closed the wallet window before connecting."), { code: 4001 }));
      waiter.current = null;
    }, 400);
    return () => clearTimeout(t);
  }, [open]);

  return useCallback(async () => {
    if (isConnected && connector) {
      setActiveProvider((await connector.getProvider()) as EIP1193Provider);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      waiter.current = { resolve, reject };
      setOpen(true);
    });
  }, [isConnected, connector, setOpen]);
}
