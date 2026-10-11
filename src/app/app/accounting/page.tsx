"use client";

import { useEffect, useMemo, useState } from "react";
import { api, useApi, when } from "@/lib/client";
import type { LinkStatus } from "@/lib/accounting/sync";
import type { AccountingProvider } from "@/lib/types";

type Status = LinkStatus & { redirectUri: string };
type Target = "xero" | "quickbooks";
type Dates = "iso" | "dmy" | "mdy";

export default function AccountingPage() {
  const { data, error, reload } = useApi<Record<AccountingProvider, Status>>("/api/accounting");
  const [flash, setFlash] = useState<{ kind: string; text: string } | null>(null);

  // The connect flow comes back here with ?provider=…&connected=1 or &error=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const p = q.get("provider");
    const name = p === "xero" ? "Xero" : p === "quickbooks" ? "QuickBooks" : "The accounting system";
    if (q.get("connected")) setFlash({ kind: "ok", text: `${name} is connected. Choose the accounts below, then sync.` });
    else if (q.get("error")) setFlash({ kind: "bad", text: `${name}: ${q.get("error")}` });
    if (q.size) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <>
      <div className="page-h">
        <div>
          <h1>Accounting</h1>
          <p>Send your invoices and payments to Xero or QuickBooks, as files or automatically.</p>
        </div>
      </div>
      {flash ? <p className={`notice ${flash.kind}`}>{flash.text}</p> : null}
      {error ? <p className="notice bad">{error}</p> : null}

      <ExportPanel />

      <div className="acct-grid">
        {data ? (
          (["xero", "quickbooks"] as const).map((p) => <Connection key={p} s={data[p]} reload={reload} />)
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
      <p className="faint" style={{ fontSize: 12.5 }}>
        USDC is booked as US dollars and EURC as euros, one to one. Duplicates and overpayments aren&apos;t invoice income, so they aren&apos;t applied to
        invoices; they show in the transactions file with their refunds. Simulated payments are never sent.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- files

function ExportPanel() {
  const [target, setTarget] = useState<Target>("xero");
  const [dates, setDates] = useState<Dates>("dmy");
  const [month, setMonth] = useState("");
  const [account, setAccount] = useState("200");
  const [tax, setTax] = useState("Tax Exempt");
  const [item, setItem] = useState("Services");
  const months = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 18; i++) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    return out;
  }, []);

  const href = (file: "invoices" | "transactions", token?: string) => {
    const q = new URLSearchParams({ target, file, dates });
    if (month) q.set("month", month);
    if (token) q.set("token", token);
    if (file === "invoices" && target === "xero") (q.set("account", account), q.set("tax", tax));
    if (file === "invoices" && target === "quickbooks") q.set("item", item);
    return `/api/accounting/export?${q}`;
  };

  return (
    <div className="panel">
      <div className="panel-h">
        Export files <span>no connection needed</span>
      </div>
      <div className="panel-b">
        <div className="row" style={{ gap: 10 }}>
          <div className="seg" role="group" aria-label="Accounting system">
            {(["xero", "quickbooks"] as const).map((t) => (
              <button key={t} aria-pressed={target === t} onClick={() => setTarget(t)}>
                {t === "xero" ? "Xero" : "QuickBooks"}
              </button>
            ))}
          </div>
          <select className="input" style={{ width: "auto" }} value={dates} onChange={(e) => setDates(e.target.value as Dates)} aria-label="Date format">
            <option value="dmy">Dates 31/12/2026</option>
            <option value="mdy">Dates 12/31/2026</option>
            <option value="iso">Dates 2026-12-31</option>
          </select>
          <select className="input" style={{ width: "auto" }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            <option value="">All months</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {new Date(m + "-01T00:00:00Z").toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {target === "xero" ? (
            <>
              <label className="field" style={{ flex: "1 1 150px" }}>
                <span>Sales account code</span>
                <input className="input" value={account} onChange={(e) => setAccount(e.target.value)} maxLength={20} />
              </label>
              <label className="field" style={{ flex: "1 1 180px" }}>
                <span>Tax rate (as named in Xero)</span>
                <input className="input" value={tax} onChange={(e) => setTax(e.target.value)} maxLength={60} />
              </label>
            </>
          ) : (
            <label className="field" style={{ flex: "1 1 220px" }}>
              <span>Product/Service in QuickBooks</span>
              <input className="input" value={item} onChange={(e) => setItem(e.target.value)} maxLength={60} />
            </label>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn primary" href={href("invoices")}>Invoices file</a>
          <a className="btn" href={href("transactions", "USDC")}>USDC transactions</a>
          <a className="btn" href={href("transactions", "EURC")}>EURC transactions</a>
        </div>
        <p className="faint" style={{ fontSize: 12.5 }}>
          {target === "xero" ? (
            <>
              In Xero, import the invoices file under <b>Sales &gt; Invoices &gt; Import</b>. Import a transactions file into the bank account you keep for that
              wallet with <b>Import a statement</b>, then match each line to its invoice. Pick the same date format when Xero asks.
            </>
          ) : (
            <>
              In QuickBooks, import the invoices file under <b>Settings &gt; Import data &gt; Invoices</b> (turn on custom transaction numbers to keep the
              INV numbers). Upload a transactions file under <b>Transactions &gt; Bank transactions &gt; Upload from file</b>, then match each line.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live connection

const GUIDE: Record<AccountingProvider, (uri: string) => React.ReactNode[]> = {
  xero: (uri) => [
    <>Sign in at <a href="https://developer.xero.com/app/manage" target="_blank" rel="noreferrer">developer.xero.com</a> with your Xero login and choose <b>New app</b>.</>,
    <>Pick <b>Web app</b>. Any name and your website as the company URL.</>,
    <>For the redirect URI, paste <RedirectUri uri={uri} /></>,
    <>Open <b>Configuration</b>, copy the client ID and <b>Generate a secret</b>. Paste both below.</>,
  ],
  quickbooks: (uri) => [
    <>Sign in at <a href="https://developer.intuit.com/app/developer/dashboard" target="_blank" rel="noreferrer">developer.intuit.com</a> and create an app for <b>QuickBooks Online</b> with the <b>Accounting</b> scope.</>,
    <>Under <b>Keys and credentials</b>, add the redirect URI <RedirectUri uri={uri} /></>,
    <>Development keys only work with a sandbox company. For your real books, complete Intuit&apos;s production questions to get production keys.</>,
    <>Copy the client ID and client secret and paste them below. Tick sandbox if they are development keys.</>,
  ],
};

function RedirectUri({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="linkbox" style={{ marginTop: 6 }}>
      <span>{uri}</span>
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          navigator.clipboard?.writeText(uri);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function Connection({ s, reload }: { s: Status; reload: () => void }) {
  const p = s.provider;
  const [clientId, setClientId] = useState(s.app?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [sandbox, setSandbox] = useState(!!s.app?.sandbox);
  const [editKeys, setEditKeys] = useState(!s.app);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: "ok", text: ok });
      reload();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const step = !s.app ? 1 : !s.connection ? 2 : 3;

  return (
    <div className="panel">
      <div className="panel-h">
        {s.label}
        {s.connection ? <span className="pill s-paid">CONNECTED</span> : s.app ? <span className="pill s-open">KEYS SAVED</span> : <span className="pill s-open">NOT SET UP</span>}
      </div>
      <div className="panel-b">
        {!s.connection ? (
          <>
            <p className="muted" style={{ fontSize: 13 }}>
              Clearmark connects with your own {s.label} app, so access stays between you and {s.label}. Set it up once:
            </p>
            <ol className="acct-steps">
              {GUIDE[p](s.redirectUri).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
          </>
        ) : null}

        {editKeys ? (
          <form
            className="stack"
            style={{ gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              run("keys", async () => {
                await api(`/api/accounting/${p}`, { method: "PUT", json: { app: { clientId, clientSecret: secret, sandbox } } });
                setSecret("");
                setEditKeys(false);
              }, "Keys saved. Now connect.");
            }}
          >
            <label className="field">
              <span>Client ID</span>
              <input className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} required />
            </label>
            <label className="field">
              <span>Client secret</span>
              <input
                className="input mono"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                placeholder={s.app ? "Saved. Paste a new one to replace it" : ""}
                required={!s.app}
              />
              <small>Stored encrypted. It is never shown again or sent to your browser.</small>
            </label>
            {p === "quickbooks" ? (
              <label className="check">
                <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
                <span>These are development keys for a sandbox company</span>
              </label>
            ) : null}
            <div className="row">
              <button className="btn primary" disabled={!!busy}>{busy === "keys" ? <span className="spinner" /> : null} Save keys</button>
              {s.app ? <button type="button" className="btn ghost" onClick={() => setEditKeys(false)}>Cancel</button> : null}
            </div>
          </form>
        ) : s.app && !s.connection ? (
          <div className="row">
            <a className="btn primary" href={`/api/accounting/${p}/connect`}>Connect {s.label}</a>
            <button className="btn ghost" onClick={() => setEditKeys(true)}>Change keys</button>
            <span className="faint mono" style={{ fontSize: 11.5 }}>{s.app.clientId.slice(0, 8)}…{s.app.sandbox ? " · sandbox" : ""}</span>
          </div>
        ) : null}

        {step === 3 ? <Connected s={s} busy={busy} run={run} /> : null}
        {s.lastError ? <p className="notice bad">{s.lastError}</p> : null}
        {msg ? <p className={`notice ${msg.kind}`}>{msg.text}</p> : null}
      </div>
    </div>
  );
}

function Connected({ s, busy, run }: { s: Status; busy: string | null; run: (k: string, fn: () => Promise<unknown>, ok?: string) => void }) {
  const p = s.provider;
  const [accounts, setAccounts] = useState<{ sales: { id: string; name: string }[]; bank: { id: string; name: string }[] } | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [form, setForm] = useState({ salesAccount: s.settings.salesAccount, usd: s.settings.bankAccount.USDC ?? "", eur: s.settings.bankAccount.EUR ?? "", since: s.settings.since, autoSync: s.settings.autoSync });

  useEffect(() => {
    api<typeof accounts>(`/api/accounting/${p}/accounts`).then(setAccounts, (e) => setAccountsError((e as Error).message));
  }, [p]);

  const bankHelp = p === "xero" ? "A Xero bank account you keep for this wallet." : "Optional. Empty means Undeposited Funds.";
  const ready = !!s.settings.salesAccount;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <p style={{ fontSize: 13.5 }}>
        Connected to <b>{s.connection!.tenantName}</b>
        {s.app?.sandbox ? " (sandbox)" : ""} since {when(s.connection!.connectedAt)}.
      </p>
      {accountsError ? <p className="notice warn">Couldn&apos;t load your accounts: {accountsError}</p> : null}
      <form
        className="stack"
        style={{ gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          run("settings", () =>
            api(`/api/accounting/${p}`, {
              method: "PUT",
              json: { settings: { salesAccount: form.salesAccount, bankAccount: { USDC: form.usd, EUR: form.eur }, since: form.since, autoSync: form.autoSync } },
            }), "Saved.");
        }}
      >
        <label className="field">
          <span>{p === "xero" ? "Sales account" : "Income account"}</span>
          <AccountSelect failed={!!accountsError} value={form.salesAccount} options={accounts?.sales} onChange={(v) => setForm({ ...form, salesAccount: v })} required />
        </label>
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <label className="field" style={{ flex: "1 1 200px" }}>
            <span>USDC payments go to</span>
            <AccountSelect failed={!!accountsError} value={form.usd} options={accounts?.bank} onChange={(v) => setForm({ ...form, usd: v })} />
            <small>{bankHelp}</small>
          </label>
          <label className="field" style={{ flex: "1 1 200px" }}>
            <span>EUR payments go to</span>
            <AccountSelect failed={!!accountsError} value={form.eur} options={accounts?.bank} onChange={(v) => setForm({ ...form, eur: v })} />
            <small>Only needed for euro invoices.</small>
          </label>
        </div>
        <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 180px" }}>
            <span>Send invoices issued from</span>
            <input className="input" type="date" value={form.since} onChange={(e) => setForm({ ...form, since: e.target.value })} />
          </label>
          <label className="check" style={{ flex: "1 1 220px", alignItems: "center", paddingBottom: 10 }}>
            <input type="checkbox" checked={form.autoSync} onChange={(e) => setForm({ ...form, autoSync: e.target.checked })} />
            <span>Sync automatically while Clearmark is open</span>
          </label>
        </div>
        <div className="row">
          <button className="btn" disabled={!!busy}>{busy === "settings" ? <span className="spinner" /> : null} Save choices</button>
        </div>
      </form>

      <div className="row muted" style={{ fontSize: 12.5, gap: 14 }}>
        <span>{s.synced.invoices} invoices · {s.synced.payments} payments sent</span>
        <span>{s.lastSyncAt ? `Last sync ${when(s.lastSyncAt)}` : "Not synced yet"}</span>
      </div>
      {s.issues.length ? (
        <div className="notice warn" style={{ fontSize: 13 }}>
          <b>Not sent yet:</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {s.issues.map((i) => (
              <li key={i.invoiceId}>
                {i.number}: {i.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="row">
        <button
          className="btn primary"
          disabled={!!busy || !ready}
          title={ready ? undefined : "Choose and save the account first"}
          onClick={() =>
            run("sync", async () => {
              const r = await api<{ invoices: number; payments: number; voided: number; issues: number; more: boolean; skipped?: string }>(`/api/accounting/${p}/sync`, { method: "POST" });
              if (r.skipped === "busy") throw new Error("A sync is already running. Give it a minute.");
            }, "Sync finished.")
          }
        >
          {busy === "sync" ? <span className="spinner" /> : null} Sync now
        </button>
        <button
          className="btn ghost"
          disabled={!!busy}
          onClick={() => {
            if (window.confirm(`Disconnect ${s.label}? Nothing already sent is removed from ${s.label}.`)) run("off", () => api(`/api/accounting/${p}`, { method: "DELETE" }), "Disconnected.");
          }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

function AccountSelect({ value, options, failed, onChange, required }: { value: string; options?: { id: string; name: string }[]; failed?: boolean; onChange: (v: string) => void; required?: boolean }) {
  if (!options) return <input className="input mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={failed ? "Account code or ID" : "Loading accounts…"} required={required} />;
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{required ? "Choose…" : "None"}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );
}
