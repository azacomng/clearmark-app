"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { shortHex } from "@/lib/arc";
import { Brand } from "./Brand";
import { IconHistory, IconInvoices, IconLogout, IconPlus, IconReview, IconShield } from "./Icons";

interface Sync {
  added: number;
  syncedTo: string | null;
  behind: boolean;
  error?: string;
}

const Ctx = createContext<{ tick: number; refresh: () => void; demo: boolean; reviewCount: number; setReviewCount: (n: number) => void }>({
  tick: 0,
  refresh: () => {},
  demo: false,
  reviewCount: 0,
  setReviewCount: () => {},
});
export const useShell = () => useContext(Ctx);

const NAV = [
  ["/app", "Invoices", IconInvoices],
  ["/app/review", "Needs review", IconReview],
  ["/app/history", "History", IconHistory],
  ["/app/limits", "Limits & settings", IconShield],
] as const;

/** Deterministic gradient avatar from a wallet address. */
function avatarFor(address: string) {
  const h = parseInt(address.slice(2, 8), 16) % 360;
  const h2 = (h + 70 + (parseInt(address.slice(8, 10), 16) % 90)) % 360;
  return `conic-gradient(from ${h}deg, hsl(${h} 90% 65%), hsl(${h2} 85% 60%), hsl(${(h2 + 120) % 360} 80% 62%), hsl(${h} 90% 65%))`;
}

export function AppShell({ address, name, demo, children }: { address: string; name: string; demo: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const [sync, setSync] = useState<Sync | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const running = useRef(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const runSync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const s = await api<Sync>("/api/sync", { method: "POST" });
      setSync(s);
      if (s.added > 0) refresh();
    } catch (e) {
      setSync({ added: 0, syncedTo: null, behind: true, error: (e as Error).message });
    } finally {
      running.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    runSync();
    const t = setInterval(runSync, 6000);
    return () => clearInterval(t);
  }, [runSync]);

  useEffect(() => {
    api<{ count: number }>("/api/review").then((r) => setReviewCount(r.count)).catch(() => {});
  }, [tick, path]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/");
  }

  const isOn = (href: string) => (href === "/app" ? path === "/app" || path.startsWith("/app/invoices") : path.startsWith(href));
  const syncLabel = sync?.error ? "Arc RPC unreachable" : sync?.syncedTo ? `Synced to block ${Number(sync.syncedTo).toLocaleString()}` : "Connecting to Arc…";

  return (
    <Ctx.Provider value={{ tick, refresh, demo, reviewCount, setReviewCount }}>
      <div className="shell">
        <nav className="side" aria-label="Main">
          <Brand href="/app" />
          <span className="nav-label">Workspace</span>
          {NAV.map(([href, label, Icon]) => (
            <Link key={href} href={href} className={`nav ${isOn(href) ? "on" : ""}`}>
              <Icon />
              <span className="lbl">{label}</span>
              {href === "/app/review" && reviewCount > 0 ? <em>{reviewCount}</em> : null}
            </Link>
          ))}
          <Link href="/app/invoices/new" className="btn primary" style={{ marginTop: 16 }}>
            <IconPlus />
            New invoice
          </Link>
          <div className="wallet">
            <span>Settlement wallet</span>
            <div className="who">
              <span className="avatar" style={{ background: avatarFor(address) }} aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <b>{name}</b>
                <span className="mono">{shortHex(address)}</span>
              </div>
            </div>
            <span className="sync" title={sync?.error ?? ""}>
              <i className={`dot ${sync?.error ? "err" : "live"}`} />
              {syncLabel}
            </span>
            <span className="chip net" style={{ justifySelf: "start" }}>Arc mainnet{demo ? " · demo on" : ""}</span>
            <button className="btn ghost sm" onClick={logout} style={{ justifySelf: "start", paddingInline: 0, border: 0, color: "var(--muted)" }}>
              <IconLogout />
              Sign out
            </button>
          </div>
        </nav>
        <div style={{ minWidth: 0 }}>
          <div className="topbar">
            <span className="mark" aria-hidden="true" />
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className={`nav ${isOn(href) ? "on" : ""}`}>
                {label}
                {href === "/app/review" && reviewCount > 0 ? ` (${reviewCount})` : ""}
              </Link>
            ))}
            <Link href="/app/invoices/new" className="nav">+ New</Link>
          </div>
          <main className="main">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
