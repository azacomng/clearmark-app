"use client";

import Link from "next/link";
import { use } from "react";
import { InvoiceDetail } from "@/components/InvoiceDetail";

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <>
      <Link href="/app" className="faint" style={{ fontSize: 13 }}>← All invoices</Link>
      <div className="card" style={{ maxWidth: 720 }}>
        <InvoiceDetail id={id} />
      </div>
    </>
  );
}
