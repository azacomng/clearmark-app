"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";

/**
 * A "QR" button that opens the payment link as a scannable code. The code carries the same /pay link,
 * so the customer's phone opens the normal checkout and the payment keeps its memo and gets matched.
 */
export function PayQr({ link, title, amount }: { link: string; title: string; amount: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>
        QR
      </button>
      {/* Portalled so the panel's blur and the link box's mono font don't reach the dialog. */}
      {open ? createPortal(<QrDialog link={link} title={title} amount={amount} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function QrDialog({ link, title, amount, onClose }: { link: string; title: string; amount: string; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    QRCode.toString(link, { type: "svg", errorCorrectionLevel: "H", margin: 2, color: { dark: "#0B0E1F", light: "#FFFFFF" } })
      .then(setSvg)
      .catch(() => setFailed(true));
  }, [link]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button.primary")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);

  async function download() {
    const url = await QRCode.toDataURL(link, { errorCorrectionLevel: "H", margin: 2, width: 960, color: { dark: "#0B0E1F", light: "#FFFFFF" } });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w-]+/g, "-")}-qr.png`;
    a.click();
  }

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title" ref={box}>
        <h3 id="qr-title">Scan to pay {title}</h3>
        <div className="qr-box" aria-label="Payment link QR code" role="img">
          {svg ? <div className="qr-code" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="muted">{failed ? "Couldn't draw the code." : "…"}</span>}
          {svg ? <span className="qr-mark mark" aria-hidden="true" /> : null}
        </div>
        <div className="qr-amt mono">{amount}</div>
        <p className="muted" style={{ fontSize: 13, textAlign: "center", margin: 0 }}>
          Point a phone camera at the code. It opens this invoice&apos;s checkout, where the customer pays from their wallet.
        </p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn sm" onClick={download} disabled={!svg}>
            Download PNG
          </button>
          <button className="btn sm primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
