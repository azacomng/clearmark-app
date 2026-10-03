// Public site details shared by metadata, share cards, the manifest, robots and the sitemap.

export const SITE_NAME = "Clearmark";
export const SITE_TAGLINE = "Every USDC payment, proven and matched.";
export const SITE_DESCRIPTION =
  "Invoice in USDC or euros and get paid on Arc. Every payment is matched to its invoice by an onchain memo, reconciled automatically and given a verifiable receipt.";

/** Canonical origin: CLEARMARK_PUBLIC_URL, else Vercel's production domain, else localhost. */
export function siteUrl(): URL {
  const explicit = process.env.CLEARMARK_PUBLIC_URL;
  if (explicit) return new URL(explicit);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return new URL(`https://${vercel}`);
  return new URL(`http://localhost:${process.env.PORT || 3000}`);
}
