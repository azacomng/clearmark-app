import type { Metadata } from "next";
import { Checkout } from "@/components/Checkout";
import { read } from "@/lib/store";

/** "Pay INV-10001 · Northwind Studio": what the payer sees in the tab and in a shared link's preview. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const db = await read();
  const inv = db.invoices[id];
  if (!inv) return { title: "Payment link not found", robots: { index: false } };
  const merchant = db.merchants[inv.merchant]?.name ?? "Clearmark merchant";
  const title = `Pay ${inv.number} · ${merchant}`;
  const description = `${inv.title}. Pay securely on Arc. Your payment is matched to this invoice and you get a verifiable receipt.`;
  return {
    title,
    description,
    robots: { index: false },
    alternates: { canonical: `/pay/${id}` },
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="stage">
      <Checkout id={id} />
    </div>
  );
}
