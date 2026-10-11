// Keeps a merchant's Xero or QuickBooks books in step with Clearmark, using the developer app the
// merchant registered themselves. Invoices go over once and are updated when they change (a settled
// discount, a void); each payment applied to an invoice goes over once, against that invoice.

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { LedgerError } from "../ledger";
import { read, write } from "../store";
import { seal, sealKey, unseal } from "../seal";
import { bookInvoices, type BookInvoice } from "./model";
import { PROVIDERS, ProviderError, type AppKeys, type Ctx } from "./providers";
import type { AccountingLink, AccountingProvider, Db, Hex } from "../types";

const LOCK_MS = 3 * 60_000;
const AUTO_EVERY_MS = 5 * 60_000;
/** API writes per run; the rest follow on the next run (Xero allows 60 calls a minute). */
const BUDGET = 40;
const CONNECT_TTL_MS = 15 * 60_000;

const emptyLink = (): AccountingLink => ({ app: null, connection: null, settings: {}, remote: { invoices: {}, payments: {} }, lastSyncAt: null, lastError: null });

export function linkOf(db: Db, m: Hex, p: AccountingProvider): AccountingLink {
  const all = (db.accounting ??= {});
  const mine = (all[m] ??= {});
  return (mine[p] ??= emptyLink());
}

const peek = (db: Db, m: Hex, p: AccountingProvider): AccountingLink | undefined => db.accounting?.[m]?.[p];

/** What the settings page may see. Never includes secrets or tokens. */
export function linkStatus(db: Db, m: Hex, p: AccountingProvider) {
  const l = peek(db, m, p);
  return {
    provider: p,
    label: PROVIDERS[p].label,
    developerUrl: PROVIDERS[p].developerUrl,
    app: l?.app ? { clientId: l.app.clientId, sandbox: !!l.app.sandbox } : null,
    connection: l?.connection ? { tenantName: l.connection.tenantName, connectedAt: l.connection.connectedAt } : null,
    settings: { salesAccount: l?.settings.salesAccount ?? "", bankAccount: l?.settings.bankAccount ?? {}, autoSync: l?.settings.autoSync !== false, since: l?.settings.since ?? "" },
    synced: { invoices: Object.keys(l?.remote.invoices ?? {}).length, payments: Object.keys(l?.remote.payments ?? {}).length },
    lastSyncAt: l?.lastSyncAt ?? null,
    lastError: l?.lastError ?? null,
    issues: Object.entries(l?.issues ?? {}).map(([invoiceId, message]) => ({ invoiceId, number: db.invoices[invoiceId]?.number ?? invoiceId, message })),
    syncing: (l?.lockUntil ?? 0) > Date.now(),
  };
}
export type LinkStatus = ReturnType<typeof linkStatus>;

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function saveApp(db: Db, m: Hex, p: AccountingProvider, input: { clientId?: unknown; clientSecret?: unknown; sandbox?: unknown }) {
  const clientId = clean(input.clientId, 200);
  const secret = clean(input.clientSecret, 200);
  const l = linkOf(db, m, p);
  if (!clientId) throw new LedgerError("Paste the client ID from your app.");
  if (!/^[\w.-]+$/.test(clientId)) throw new LedgerError("That client ID has characters a client ID can't have.");
  // Keep the saved secret when only the client ID or sandbox switch changes.
  if (!secret && !l.app) throw new LedgerError("Paste the client secret from your app.");
  const changedApp = l.app && l.app.clientId !== clientId;
  if (changedApp && !secret) throw new LedgerError("A new client ID needs its client secret too.");
  l.app = {
    clientId,
    clientSecret: secret ? seal(secret, sealKey(db)) : l.app!.clientSecret,
    ...(p === "quickbooks" ? { sandbox: input.sandbox === true } : {}),
  };
  // Tokens belong to the app that issued them.
  if (changedApp || (p === "quickbooks" && l.connection && !!input.sandbox !== !!l.app.sandbox)) l.connection = null;
}

export function saveSettings(db: Db, m: Hex, p: AccountingProvider, input: { salesAccount?: unknown; bankAccount?: unknown; autoSync?: unknown; since?: unknown }) {
  const l = linkOf(db, m, p);
  if (input.salesAccount !== undefined) l.settings.salesAccount = clean(input.salesAccount, 100) || undefined;
  if (input.bankAccount !== undefined) {
    const b = (input.bankAccount ?? {}) as Record<string, unknown>;
    l.settings.bankAccount = { USDC: clean(b.USDC, 100) || undefined, EUR: clean(b.EUR, 100) || undefined };
  }
  if (input.autoSync !== undefined) l.settings.autoSync = input.autoSync !== false;
  if (input.since !== undefined) {
    const s = clean(input.since, 10);
    if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new LedgerError("The start date must look like 2026-10-01.");
    l.settings.since = s || undefined;
  }
  // Settings changed what a push looks like: let invoices that failed try again.
  l.issues = {};
}

function appKeys(db: Db, l: AccountingLink): AppKeys {
  if (!l.app) throw new LedgerError("Add your app's client ID and secret first.");
  return { clientId: l.app.clientId, clientSecret: unseal(l.app.clientSecret, sealKey(db)), sandbox: l.app.sandbox };
}

/** Start the provider's sign-in. The state is bound to this merchant and to a cookie in their browser. */
export async function beginConnect(m: Hex, p: AccountingProvider, redirectUri: string): Promise<{ url: string; state: string }> {
  const state = randomBytes(24).toString("hex");
  const app = await write((db) => {
    const l = linkOf(db, m, p);
    const keys = appKeys(db, l);
    l.pending = { state, expires: Date.now() + CONNECT_TTL_MS };
    return keys;
  });
  return { url: PROVIDERS[p].authorizeUrl(app, redirectUri, state), state };
}

export async function finishConnect(m: Hex, p: AccountingProvider, params: URLSearchParams, redirectUri: string, cookieState: string | undefined) {
  const state = params.get("state") ?? "";
  const ok = await write((db) => {
    const l = linkOf(db, m, p);
    const pending = l.pending;
    l.pending = null;
    return !!pending && pending.expires > Date.now() && !!cookieState && pending.state === state && cookieState === state;
  });
  if (!ok) throw new LedgerError("That sign-in link expired or didn't start here. Try connecting again.");
  const denied = params.get("error");
  if (denied) throw new LedgerError(denied === "access_denied" ? "Access wasn't granted." : `The sign-in was stopped: ${denied}`);
  const code = params.get("code");
  if (!code) throw new LedgerError("The sign-in didn't return a code. Try again.");

  const db0 = await read();
  const app = appKeys(db0, linkOf(db0, m, p));
  const tokens = await PROVIDERS[p].exchange(app, code, redirectUri);
  const tenant = await PROVIDERS[p].tenant(tokens, params, app);
  return write((db) => {
    const l = linkOf(db, m, p);
    const key = sealKey(db);
    if (l.connection?.tenantId !== tenant.tenantId) {
      // A different organisation: nothing pushed before exists there.
      l.remote = { invoices: {}, payments: {} };
      l.issues = {};
      l.lastSyncAt = null;
    }
    l.connection = {
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName.slice(0, 120),
      connectionId: tenant.connectionId,
      accessToken: seal(tokens.accessToken, key),
      refreshToken: seal(tokens.refreshToken, key),
      accessExpires: Date.now() + tokens.expiresIn * 1000,
      connectedAt: new Date().toISOString(),
    };
    l.lastError = null;
    // By default only invoices from this month on go over, so connecting doesn't flood the books with history.
    l.settings.since ??= new Date().toISOString().slice(0, 8) + "01";
    return tenant.tenantName;
  });
}

export async function disconnect(m: Hex, p: AccountingProvider, removeKeys: boolean) {
  const prev = await write((db) => {
    const l = peek(db, m, p);
    if (!l) return null;
    let revoke: { app: AppKeys; token: string } | null = null;
    try {
      if (l.app && l.connection) revoke = { app: appKeys(db, l), token: unseal(l.connection.refreshToken, sealKey(db)) };
    } catch {
      /* unreadable keys: nothing to revoke with */
    }
    l.connection = null;
    l.pending = null;
    l.lockUntil = 0;
    if (removeKeys) l.app = null;
    return revoke;
  });
  if (prev) await PROVIDERS[p].revoke(prev.app, prev.token);
}

/** A context with a live access token, refreshing (and saving the rotated refresh token) when needed. */
async function liveCtx(m: Hex, p: AccountingProvider): Promise<{ ctx: Ctx; app: AppKeys }> {
  const db = await read();
  const l = peek(db, m, p);
  if (!l?.connection) throw new LedgerError(`Connect ${PROVIDERS[p].label} first.`);
  const key = sealKey(db);
  const app = appKeys(db, l);
  let accessToken = unseal(l.connection.accessToken, key);
  if (l.connection.accessExpires - 60_000 < Date.now()) {
    let t;
    try {
      t = await PROVIDERS[p].refresh(app, unseal(l.connection.refreshToken, key));
    } catch (e) {
      if (e instanceof ProviderError && e.status === 400) {
        await write((d) => {
          const x = linkOf(d, m, p);
          x.connection = null;
          x.lastError = `${PROVIDERS[p].label} ended the connection (it expires after a long time unused, or was disconnected there). Connect again.`;
        });
      }
      throw e;
    }
    accessToken = t.accessToken;
    await write((d) => {
      const c = linkOf(d, m, p).connection;
      if (!c) return;
      const k = sealKey(d);
      c.accessToken = seal(t.accessToken, k);
      c.refreshToken = seal(t.refreshToken, k);
      c.accessExpires = Date.now() + t.expiresIn * 1000;
    });
  }
  const s = l.settings;
  return {
    app,
    ctx: {
      accessToken,
      tenantId: l.connection.tenantId,
      sandbox: !!l.app?.sandbox,
      salesAccount: s.salesAccount ?? "",
      bankAccount: (c) => (c === "EUR" ? s.bankAccount?.EUR : s.bankAccount?.USDC),
      cache: { customers: { ...(l.remote.customers ?? {}) }, item: l.remote.item },
    },
  };
}

export async function accountOptions(m: Hex, p: AccountingProvider) {
  const { ctx } = await liveCtx(m, p);
  return PROVIDERS[p].accounts(ctx);
}

/** Changes when anything sent with the invoice changes. */
export function invoiceSig(b: BookInvoice): string {
  const data = [b.number, b.customerName, b.customerEmail, b.issueDate, b.dueDate, b.currency, b.lines.map((l) => [l.description, l.amount.toString()])];
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 20);
}

export interface SyncResult {
  invoices: number;
  payments: number;
  voided: number;
  issues: number;
  more: boolean;
  skipped?: "busy" | "not_ready";
}

export async function syncAccounting(m: Hex, p: AccountingProvider, origin: string): Promise<SyncResult> {
  const claimed = await write((db) => {
    const l = peek(db, m, p);
    if (!l?.connection) throw new LedgerError(`Connect ${PROVIDERS[p].label} first.`);
    if ((l.lockUntil ?? 0) > Date.now()) return false;
    l.lockUntil = Date.now() + LOCK_MS;
    return true;
  });
  const result: SyncResult = { invoices: 0, payments: 0, voided: 0, issues: 0, more: false };
  if (!claimed) return { ...result, skipped: "busy" };

  const issues: Record<string, string> = {};
  let fatal: string | null = null;
  try {
    const { ctx } = await liveCtx(m, p);
    if (!ctx.salesAccount) {
      fatal = p === "xero" ? "Choose the Xero sales account invoices are booked to." : "Choose the QuickBooks income account invoices are booked to.";
      return { ...result, skipped: "not_ready" };
    }
    const db = await read();
    const link = linkOf(db, m, p);
    const since = link.settings.since ?? "";
    const remote = link.remote;
    let budget = BUDGET;
    const api = PROVIDERS[p];

    for (const b of bookInvoices(db, m, origin)) {
      const rec = remote.invoices[b.id];
      if (!rec && (b.voided || b.issueDate < since)) continue;
      const sig = invoiceSig(b);
      const owes = b.voided ? !rec!.voided : !rec || rec.sig !== sig || b.payments.some((x) => !remote.payments[x.id]);
      if (!owes) continue;
      if (budget <= 0) {
        result.more = true;
        break;
      }
      // Each invoice is saved as soon as it's done, so a failure later in the run loses nothing.
      const done: { invoice?: AccountingLink["remote"]["invoices"][string]; payments: Record<string, string> } = { payments: {} };
      try {
        if (b.voided) {
          await api.voidInvoice(ctx, rec!.id);
          budget -= 2;
          done.invoice = { ...rec!, voided: true };
          result.voided++;
        } else {
          let r = rec ?? null;
          if (!r || r.sig !== sig) {
            const out = await api.pushInvoice(ctx, b, r);
            budget -= 3;
            r = { id: out.id, sig, customer: out.customer ?? r?.customer };
            done.invoice = r;
            result.invoices++;
          }
          for (const pay of b.payments) {
            if (remote.payments[pay.id]) continue;
            done.payments[pay.id] = await api.pushPayment(ctx, b, pay, r);
            budget -= 1;
            result.payments++;
          }
        }
      } catch (e) {
        if (e instanceof ProviderError && e.status === 401) throw e;
        if (e instanceof ProviderError && e.status === 429) result.more = true;
        else issues[b.id] = (e as Error).message;
      } finally {
        if (done.invoice || Object.keys(done.payments).length) {
          if (done.invoice) remote.invoices[b.id] = done.invoice;
          Object.assign(remote.payments, done.payments);
          await write((d) => {
            const l = linkOf(d, m, p);
            if (done.invoice) l.remote.invoices[b.id] = done.invoice;
            Object.assign(l.remote.payments, done.payments);
            l.remote.customers = { ...(l.remote.customers ?? {}), ...ctx.cache.customers };
            l.remote.item = ctx.cache.item ?? l.remote.item;
          });
        }
      }
      if (result.more) break;
    }
    result.issues = Object.keys(issues).length;
    return result;
  } catch (e) {
    fatal = e instanceof ProviderError && e.status === 401 ? "Access was refused. Connect again." : (e as Error).message;
    throw e;
  } finally {
    await write((d) => {
      const l = linkOf(d, m, p);
      l.lockUntil = 0;
      l.lastSyncAt = new Date().toISOString();
      l.lastError = fatal;
      if (!fatal) l.issues = issues;
    });
  }
}

/** Called after the dashboard's regular sync: runs each connection that is due. Errors are recorded, not thrown. */
export async function autoSyncAccounting(m: Hex, origin: string) {
  const db = await read();
  for (const p of ["xero", "quickbooks"] as const) {
    const l = peek(db, m, p);
    if (!l?.connection || l.settings.autoSync === false || !l.settings.salesAccount) continue;
    if (l.lastSyncAt && Date.now() - Date.parse(l.lastSyncAt) < AUTO_EVERY_MS) continue;
    await syncAccounting(m, p, origin).catch(() => {});
  }
}
