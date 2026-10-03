import type { Metadata, Viewport } from "next";
import { Fx } from "@/components/Fx";
import { WalletProvider } from "@/components/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clearmark",
  description: "Every USDC payment, proven and matched. Invoice verification and automatic reconciliation on Arc.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#05060E" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <Fx />
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
