"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Red confirm button, for actions that can't be undone. */
  danger?: boolean;
  /** Ask for a reason before confirming. Quick picks fill the box. */
  reason?: { presets: string[]; placeholder?: string };
}

type Pending = ConfirmOptions & { resolve: (v: string | null) => void };

/**
 * A confirm step for actions that can't be undone. `ask` resolves with the reason (or "" when no reason
 * is asked for) once confirmed, and with null when the person backs out.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((opts: ConfirmOptions) => new Promise<string | null>((resolve) => setPending({ ...opts, resolve })), []);
  const close = (v: string | null) => {
    pending?.resolve(v);
    setPending(null);
  };
  const dialog = pending ? <ConfirmDialog key={pending.title} opts={pending} onClose={close} /> : null;
  return { ask, dialog };
}

function ConfirmDialog({ opts, onClose }: { opts: ConfirmOptions; onClose: (v: string | null) => void }) {
  const [reason, setReason] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const needsReason = !!opts.reason;
  const ok = !needsReason || reason.trim().length >= 3;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(needsReason ? "textarea" : "button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [needsReason]);

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" ref={box}>
        <h3 id="confirm-title">{opts.title}</h3>
        <div className="muted" style={{ fontSize: 13.5 }}>{opts.body}</div>
        {opts.reason ? (
          <div className="field">
            <span>Reason</span>
            <div className="row" style={{ gap: 6 }}>
              {opts.reason.presets.map((p) => (
                <button key={p} type="button" className="btn sm" aria-pressed={reason === p} onClick={() => setReason(p)}>
                  {p}
                </button>
              ))}
            </div>
            <textarea rows={2} maxLength={200} aria-label="Reason" value={reason} placeholder={opts.reason.placeholder ?? "Why?"} onChange={(e) => setReason(e.target.value)} />
            <small>Kept in the history with your wallet address and the time.</small>
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn sm" onClick={() => onClose(null)}>Go back</button>
          <button className={`btn sm ${opts.danger ? "danger solid" : "primary"}`} disabled={!ok} onClick={() => onClose(needsReason ? reason.trim() : "")}>
            {opts.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
