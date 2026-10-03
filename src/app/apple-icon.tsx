import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg,#7F8CFF 0%,#B57BFF 45%,#3EE6E0 80%,#F2CB7E 100%)",
        }}
      >
        <div style={{ width: 150, height: 150, borderRadius: 38, background: "#0B0E1F", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="90" height="90" viewBox="0 0 64 64">
            <path d="M14 33.5l12 12 24-26" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    ),
    size,
  );
}
