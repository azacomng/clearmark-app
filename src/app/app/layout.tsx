import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sessionAddress } from "@/lib/auth";
import { read } from "@/lib/store";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

// The merchant workspace is private: never indexed.
export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

export default async function MerchantLayout({ children }: { children: React.ReactNode }) {
  const address = await sessionAddress();
  if (!address) redirect("/");
  const db = await read();
  const m = db.merchants[address];
  if (!m) redirect("/");
  return (
    <AppShell address={address} name={m.name} demo={process.env.CLEARMARK_DEMO === "1"}>
      {children}
    </AppShell>
  );
}
