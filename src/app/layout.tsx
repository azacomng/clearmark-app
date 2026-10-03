import type { Metadata, Viewport } from "next";
import { Fx } from "@/components/Fx";
import { WalletProvider } from "@/components/WalletProvider";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, siteUrl } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: `${SITE_NAME} · ${SITE_TAGLINE}`, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: ["USDC invoices", "EURC", "crypto invoicing", "payment reconciliation", "Arc", "Circle", "stablecoin payments", "onchain receipts"],
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: SITE_NAME, title: `${SITE_NAME} · ${SITE_TAGLINE}`, description: SITE_DESCRIPTION, url: "/", locale: "en_US" },
  twitter: { card: "summary_large_image", title: `${SITE_NAME} · ${SITE_TAGLINE}`, description: SITE_DESCRIPTION },
  appleWebApp: { title: SITE_NAME, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
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
