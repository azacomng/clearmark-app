// The share card: what a proof link turns into when it's pasted in WhatsApp, X, Slack or email.

import { ImageResponse } from "next/og";
import { LedgerError } from "@/lib/ledger";
import { fmt } from "@/lib/money";
import { receiptData } from "@/lib/receipts";
import { read } from "@/lib/store";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Clearmark proof receipt";

const GOLD = "#F2CB7E";

export default async function Image({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  let r;
  try {
    r = receiptData(await read(), kind, id);
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    r = null;
  }

  const headline = !r ? "Receipt not found" : r.publicAmounts ? `${fmt(r.amount)} USDC` : r.kind === "refund" ? "Refund sent" : "Payment received";
  const sub = !r ? "" : r.kind === "refund" ? `Refunded by ${r.merchantName}` : `Paid to ${r.merchantName}${r.invoice ? ` · ${r.invoice.number}` : ""}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "radial-gradient(120% 90% at 85% 0%, #1B1F4A 0%, #0A0D1C 45%, #05060E 100%)",
          color: "#EEF1FF",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "linear-gradient(115deg,#7F8CFF 0%,#B57BFF 45%,#3EE6E0 100%)",
                display: "flex",
              }}
            />
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1 }}>Clearmark</div>
          </div>
          <div style={{ display: "flex", fontSize: 22, color: "#98A2C3", letterSpacing: 3 }}>
            {r?.source === "demo" ? "ARC TESTNET · SIMULATED" : "ARC TESTNET"}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 40 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 760 }}>
            <div style={{ display: "flex", fontSize: 26, color: "#8B9DFF", letterSpacing: 5 }}>
              {r?.kind === "refund" ? "REFUND RECEIPT" : "PROOF RECEIPT"}
            </div>
            <div style={{ display: "flex", fontSize: 92, fontWeight: 700, letterSpacing: -3, lineHeight: 1 }}>{headline}</div>
            <div style={{ display: "flex", fontSize: 30, color: "#98A2C3" }}>{sub}</div>
          </div>
          {r ? (
            <div
              style={{
                width: 250,
                height: 250,
                borderRadius: 999,
                border: `5px solid ${GOLD}`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: GOLD,
                transform: "rotate(-8deg)",
                boxShadow: `0 0 80px -10px ${GOLD}`,
                background: "radial-gradient(circle, rgba(242,203,126,.16), #0A0D1C 72%)",
              }}
            >
              <div style={{ display: "flex", fontSize: 18, letterSpacing: 4 }}>CLEARMARK</div>
              <div style={{ display: "flex", fontSize: 44, fontWeight: 700, margin: "8px 0" }}>{r.seal}</div>
              <div style={{ display: "flex", fontSize: 18, letterSpacing: 4 }}>FINAL</div>
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 24px",
              borderRadius: 999,
              border: `2px solid rgba(242,203,126,.45)`,
              background: "rgba(242,203,126,.11)",
              color: GOLD,
              fontSize: 28,
            }}
          >
            <div style={{ width: 14, height: 14, borderRadius: 99, background: GOLD, display: "flex" }} />
            {r ? r.settled : "Clearmark"}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: "#98A2C3" }}>Invoice with Clearmark</div>
        </div>
      </div>
    ),
    size,
  );
}
