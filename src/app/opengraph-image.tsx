// The preview card shown when the Clearmark homepage is shared.

import { ImageResponse } from "next/og";
import { SITE_TAGLINE } from "@/lib/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Clearmark: every USDC payment, proven and matched";

const PILLS: [string, string][] = [
  ["PAID", "#3EE6A0"],
  ["PAID · EARLY DISCOUNT", "#3EE6A0"],
  ["OVERPAID", "#3EE6E0"],
  ["NEEDS REVIEW", "#F2CB7E"],
];

export default function Image() {
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
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "linear-gradient(135deg,#7F8CFF,#B57BFF 45%,#3EE6E0 80%,#F2CB7E)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 46, height: 46, borderRadius: 12, background: "#0B0E1F", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="30" height="30" viewBox="0 0 64 64">
                <path d="M14 33.5l12 12 24-26" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Clearmark</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", fontSize: 80, fontWeight: 700, letterSpacing: -3, lineHeight: 1.02, maxWidth: 1000 }}>{SITE_TAGLINE}</div>
          <div style={{ display: "flex", fontSize: 30, color: "#98A2C3" }}>USDC and euro invoices on Arc, reconciled automatically, with a receipt for every payment.</div>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          {PILLS.map(([t, c]) => (
            <div key={t} style={{ display: "flex", padding: "10px 20px", borderRadius: 999, border: `2px solid ${c}`, color: c, fontSize: 22, letterSpacing: 2 }}>
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
