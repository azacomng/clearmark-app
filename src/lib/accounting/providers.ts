// Xero and QuickBooks Online over their REST APIs, with the merchant's own developer app.
//
// Both use OAuth 2.0 authorization code with a client secret: Clearmark sends the merchant to the
// provider to approve access, gets a code back on the redirect URI they registered, and swaps it for
// an access token (short-lived) and a refresh token (rotates on every refresh, so it is saved each time).

import "server-only";
import { money, type BookInvoice, type BookPayment } from "./model";
import type { AccountingProvider } from "../types";

export interface AppKeys {
  clientId: string;
  clientSecret: string;
  sandbox?: boolean;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
}

export interface Tenant {
  tenantId: string;
  tenantName: string;
  connectionId?: string;
}

export interface AccountOption {
  id: string;
  name: string;
}

/** What a push needs: a live token, the organisation, and the merchant's account choices. */
export interface Ctx {
  accessToken: string;
  tenantId: string;
  sandbox: boolean;
  salesAccount: string;
  /** Per invoice currency (USD/EUR). */
  bankAccount: (currency: "USD" | "EUR") => string | undefined;
  /** Cache of ids Clearmark already knows in the remote books; mutated as new ones are made. */
  cache: { customers: Record<string, string>; item?: string };
}

export class ProviderError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export interface Provider {
  label: string;
  /** Where the merchant registers their app. */
  developerUrl: string;
  authorizeUrl(app: AppKeys, redirectUri: string, state: string): string;
  exchange(app: AppKeys, code: string, redirectUri: string): Promise<Tokens>;
  refresh(app: AppKeys, refreshToken: string): Promise<Tokens>;
  /** Which organisation was just connected. `params` are the callback's query parameters. */
  tenant(tokens: Tokens, params: URLSearchParams, app: AppKeys): Promise<Tenant>;
  revoke(app: AppKeys, refreshToken: string): Promise<void>;
  accounts(ctx: Ctx): Promise<{ sales: AccountOption[]; bank: AccountOption[] }>;
  /** Create the invoice, or update it when `existing` is given. Adopts an invoice with the same number. */
  pushInvoice(ctx: Ctx, inv: BookInvoice, existing: { id: string; customer?: string } | null): Promise<{ id: string; customer?: string }>;
  voidInvoice(ctx: Ctx, remoteId: string): Promise<void>;
  pushPayment(ctx: Ctx, inv: BookInvoice, p: BookPayment, remote: { id: string; customer?: string }): Promise<string>;
}

const basic = (app: AppKeys) => "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
const num = (u: bigint) => Number(money(u));

async function call<T>(url: string, init: RequestInit, describe: (body: unknown) => string | undefined): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ProviderError("Couldn't reach the accounting service. Try again in a minute.");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const why = describe(body) ?? (res.status === 429 ? "Too many requests right now; the rest will sync on the next run." : `Request failed (${res.status}).`);
    throw new ProviderError(why, res.status);
  }
  return body as T;
}

async function tokenRequest(url: string, app: AppKeys, form: Record<string, string>): Promise<Tokens> {
  const t = await call<{ access_token: string; refresh_token: string; expires_in: number }>(
    url,
    { method: "POST", headers: { authorization: basic(app), "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) },
    (b) => {
      const e = (b as { error?: string; error_description?: string } | null)?.error;
      if (e === "invalid_client") return "The client ID or secret was not accepted. Check the app keys.";
      if (e === "invalid_grant") return "The connection has expired or was revoked. Connect again.";
      return e ? `Sign-in failed: ${e}` : undefined;
    },
  );
  if (!t?.access_token || !t.refresh_token) throw new ProviderError("Sign-in returned no tokens.");
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: Number(t.expires_in) || 1800 };
}

// ---------------------------------------------------------------- Xero

const XERO_API = "https://api.xero.com/api.xro/2.0";
// Granular scopes (apps created from March 2026 use these; accounting.transactions is being retired).
const XERO_SCOPES = "offline_access accounting.invoices accounting.payments accounting.contacts accounting.settings.read";

type XeroAccount = { AccountID: string; Code?: string; Name: string; Type: string; Class?: string; Status: string; CurrencyCode?: string };
type XeroInvoice = { InvoiceID: string; Status: string; Contact?: { ContactID: string } };

const xeroError = (b: unknown) => {
  const o = b as { Elements?: { ValidationErrors?: { Message: string }[] }[]; Message?: string; Detail?: string; Title?: string } | null;
  const v = o?.Elements?.flatMap((e) => e.ValidationErrors ?? []).map((e) => e.Message);
  return v?.length ? v.join(" ") : o?.Detail ?? o?.Message ?? o?.Title;
};

function xero(ctx: Ctx, path: string, init: RequestInit = {}) {
  return call<Record<string, unknown>>(
    `${XERO_API}${path}`,
    {
      ...init,
      headers: { authorization: `Bearer ${ctx.accessToken}`, "xero-tenant-id": ctx.tenantId, accept: "application/json", "content-type": "application/json" },
    },
    xeroError,
  );
}

export const Xero: Provider = {
  label: "Xero",
  developerUrl: "https://developer.xero.com/app/manage",
  authorizeUrl: (app, redirectUri, state) =>
    "https://login.xero.com/identity/connect/authorize?" +
    new URLSearchParams({ response_type: "code", client_id: app.clientId, redirect_uri: redirectUri, scope: XERO_SCOPES, state }),
  exchange: (app, code, redirectUri) =>
    tokenRequest("https://identity.xero.com/connect/token", app, { grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  refresh: (app, refreshToken) => tokenRequest("https://identity.xero.com/connect/token", app, { grant_type: "refresh_token", refresh_token: refreshToken }),
  async tenant(tokens) {
    const list = await call<{ id: string; tenantId: string; tenantType: string; tenantName: string | null }[]>(
      "https://api.xero.com/connections",
      { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" } },
      xeroError,
    );
    const org = list?.find((c) => c.tenantType === "ORGANISATION");
    if (!org) throw new ProviderError("No Xero organisation was shared. Connect again and pick an organisation.");
    return { tenantId: org.tenantId, tenantName: org.tenantName ?? "Xero organisation", connectionId: org.id };
  },
  async revoke(app, refreshToken) {
    await tokenRevoke("https://identity.xero.com/connect/revocation", app, new URLSearchParams({ token: refreshToken }), "application/x-www-form-urlencoded");
  },
  async accounts(ctx) {
    const r = (await xero(ctx, "/Accounts")) as { Accounts?: XeroAccount[] };
    const active = (r.Accounts ?? []).filter((a) => a.Status === "ACTIVE");
    return {
      sales: active.filter((a) => a.Class === "REVENUE" && a.Code).map((a) => ({ id: a.Code!, name: `${a.Code} · ${a.Name}` })),
      bank: active.filter((a) => a.Type === "BANK").map((a) => ({ id: a.AccountID, name: `${a.Name}${a.CurrencyCode ? ` (${a.CurrencyCode})` : ""}` })),
    };
  },
  async pushInvoice(ctx, inv, existing) {
    let id = existing?.id;
    if (!id) {
      // Adopt an invoice with this number if it's already there (an earlier file import, or a lost reply).
      const q = new URLSearchParams({ InvoiceNumbers: inv.number, Statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID" });
      const found = (await xero(ctx, `/Invoices?${q}`)) as { Invoices?: XeroInvoice[] };
      id = found.Invoices?.[0]?.InvoiceID;
    }
    const body = {
      Invoices: [
        {
          ...(id ? { InvoiceID: id } : {}),
          Type: "ACCREC",
          Contact: { Name: inv.customerName, ...(inv.customerEmail ? { EmailAddress: inv.customerEmail } : {}) },
          Date: inv.issueDate,
          DueDate: inv.dueDate,
          InvoiceNumber: inv.number,
          Reference: `Clearmark ${inv.id}`,
          Url: inv.paymentLink,
          CurrencyCode: inv.currency,
          Status: "AUTHORISED",
          LineAmountTypes: "NoTax",
          LineItems: inv.lines.map((l) => ({ Description: l.description, Quantity: 1, UnitAmount: num(l.amount), AccountCode: ctx.salesAccount })),
        },
      ],
    };
    const r = (await xero(ctx, "/Invoices", { method: "POST", body: JSON.stringify(body) })) as { Invoices?: XeroInvoice[] };
    const out = r.Invoices?.[0];
    if (!out?.InvoiceID) throw new ProviderError("Xero didn't return the invoice.");
    return { id: out.InvoiceID, customer: out.Contact?.ContactID };
  },
  async voidInvoice(ctx, remoteId) {
    await xero(ctx, `/Invoices/${remoteId}`, { method: "POST", body: JSON.stringify({ Invoices: [{ InvoiceID: remoteId, Status: "VOIDED" }] }) });
  },
  async pushPayment(ctx, inv, p, remote) {
    const account = ctx.bankAccount(inv.currency);
    if (!account) throw new ProviderError(`Choose the Xero bank account that ${inv.currency} payments go to.`);
    const body = { Payments: [{ Invoice: { InvoiceID: remote.id }, Account: { AccountID: account }, Date: p.date, Amount: num(p.amount), Reference: p.txHash }] };
    const r = (await xero(ctx, "/Payments", { method: "PUT", body: JSON.stringify(body) })) as { Payments?: { PaymentID: string }[] };
    const id = r.Payments?.[0]?.PaymentID;
    if (!id) throw new ProviderError("Xero didn't return the payment.");
    return id;
  },
};

// ---------------------------------------------------------------- QuickBooks Online

const QB_MINOR = "75";
const qbBase = (ctx: Pick<Ctx, "sandbox" | "tenantId">) =>
  `https://${ctx.sandbox ? "sandbox-quickbooks" : "quickbooks"}.api.intuit.com/v3/company/${encodeURIComponent(ctx.tenantId)}`;

const qbError = (b: unknown) => {
  const e = (b as { Fault?: { Error?: { Message?: string; Detail?: string }[] } } | null)?.Fault?.Error?.[0];
  return e ? e.Detail || e.Message : undefined;
};

function qb<T = Record<string, unknown>>(ctx: Pick<Ctx, "sandbox" | "tenantId" | "accessToken">, path: string, init: RequestInit = {}) {
  const sep = path.includes("?") ? "&" : "?";
  return call<T>(
    `${qbBase(ctx)}${path}${sep}minorversion=${QB_MINOR}`,
    { ...init, headers: { authorization: `Bearer ${ctx.accessToken}`, accept: "application/json", "content-type": "application/json" } },
    qbError,
  );
}

/** QuickBooks query language: strings are single-quoted with backslash escapes. */
const qstr = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function qbQuery<T>(ctx: Ctx, entity: string, where: string): Promise<T[]> {
  const r = await qb<{ QueryResponse?: Record<string, T[]> }>(ctx, `/query?query=${encodeURIComponent(`select * from ${entity} where ${where}`)}`);
  return r.QueryResponse?.[entity] ?? [];
}

type QbRef = { value: string; name?: string };
type QbCustomer = { Id: string; DisplayName: string; CurrencyRef?: QbRef };
type QbInvoice = { Id: string; SyncToken: string; CustomerRef: QbRef };

/** QuickBooks display names can't contain colons, tabs or new lines. */
const displayName = (s: string) => s.replace(/[:\t\r\n]/g, " ").trim().slice(0, 100) || "Customer";

async function qbCustomer(ctx: Ctx, inv: BookInvoice): Promise<string> {
  const key = `${inv.customerName}|${inv.currency}`;
  if (ctx.cache.customers[key]) return ctx.cache.customers[key];
  // A customer without a currency is in the company's home currency, taken to be USD.
  const fits = (c: QbCustomer) => (c.CurrencyRef?.value ?? "USD") === inv.currency;
  let name = displayName(inv.customerName);
  let found = (await qbQuery<QbCustomer>(ctx, "Customer", `DisplayName = ${qstr(name)}`))[0];
  if (found && !fits(found)) {
    // Same customer, other currency: QuickBooks needs one customer record per currency.
    name = displayName(`${inv.customerName} (${inv.currency})`);
    found = (await qbQuery<QbCustomer>(ctx, "Customer", `DisplayName = ${qstr(name)}`))[0];
  }
  let id = found?.Id;
  if (!id) {
    const body = {
      DisplayName: name,
      ...(inv.customerEmail ? { PrimaryEmailAddr: { Address: inv.customerEmail } } : {}),
      ...(inv.currency === "EUR" ? { CurrencyRef: { value: "EUR" } } : {}),
    };
    id = (await qb<{ Customer: QbCustomer }>(ctx, "/customer", { method: "POST", body: JSON.stringify(body) })).Customer.Id;
  }
  ctx.cache.customers[key] = id;
  return id;
}

/** A "Clearmark" service item, booked to the income account the merchant chose. */
async function qbItem(ctx: Ctx): Promise<string> {
  if (ctx.cache.item) return ctx.cache.item;
  let id = (await qbQuery<{ Id: string }>(ctx, "Item", `Name = 'Clearmark'`))[0]?.Id;
  if (!id) {
    if (!ctx.salesAccount) throw new ProviderError("Choose the QuickBooks income account first.");
    const body = { Name: "Clearmark", Type: "Service", IncomeAccountRef: { value: ctx.salesAccount } };
    id = (await qb<{ Item: { Id: string } }>(ctx, "/item", { method: "POST", body: JSON.stringify(body) })).Item.Id;
  }
  ctx.cache.item = id;
  return id;
}

export const QuickBooks: Provider = {
  label: "QuickBooks",
  developerUrl: "https://developer.intuit.com/app/developer/dashboard",
  authorizeUrl: (app, redirectUri, state) =>
    "https://appcenter.intuit.com/connect/oauth2?" +
    new URLSearchParams({ client_id: app.clientId, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirectUri, state }),
  exchange: (app, code, redirectUri) =>
    tokenRequest("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", app, { grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  refresh: (app, refreshToken) =>
    tokenRequest("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", app, { grant_type: "refresh_token", refresh_token: refreshToken }),
  async tenant(tokens, params, app) {
    const realm = params.get("realmId");
    if (!realm || !/^\d+$/.test(realm)) throw new ProviderError("QuickBooks didn't say which company was connected.");
    const ctx = { accessToken: tokens.accessToken, tenantId: realm, sandbox: !!app.sandbox };
    const r = await qb<{ CompanyInfo?: { CompanyName?: string } }>(ctx, `/companyinfo/${realm}`).catch(() => null);
    return { tenantId: realm, tenantName: r?.CompanyInfo?.CompanyName ?? `Company ${realm}` };
  },
  async revoke(app, refreshToken) {
    await tokenRevoke("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", app, JSON.stringify({ token: refreshToken }), "application/json");
  },
  async accounts(ctx) {
    type A = { Id: string; Name: string; AccountType: string; CurrencyRef?: QbRef };
    const all = await qbQuery<A>(ctx, "Account", "Active = true MAXRESULTS 1000");
    const label = (a: A) => `${a.Name}${a.CurrencyRef?.value ? ` (${a.CurrencyRef.value})` : ""}`;
    return {
      sales: all.filter((a) => a.AccountType === "Income").map((a) => ({ id: a.Id, name: label(a) })),
      bank: all.filter((a) => a.AccountType === "Bank" || a.AccountType === "Other Current Asset").map((a) => ({ id: a.Id, name: label(a) })),
    };
  },
  async pushInvoice(ctx, inv, existing) {
    const item = await qbItem(ctx);
    let current: QbInvoice | undefined;
    if (existing) current = (await qb<{ Invoice: QbInvoice }>(ctx, `/invoice/${existing.id}`)).Invoice;
    else current = (await qbQuery<QbInvoice>(ctx, "Invoice", `DocNumber = ${qstr(inv.number)}`))[0];
    const customer = current?.CustomerRef.value ?? (await qbCustomer(ctx, inv));
    const body = {
      ...(current ? { Id: current.Id, SyncToken: current.SyncToken, sparse: true } : {}),
      CustomerRef: { value: customer },
      DocNumber: inv.number.slice(0, 21),
      TxnDate: inv.issueDate,
      DueDate: inv.dueDate,
      PrivateNote: `Clearmark ${inv.id} · ${inv.paymentLink}`,
      ...(inv.customerEmail ? { BillEmail: { Address: inv.customerEmail } } : {}),
      ...(inv.currency === "EUR" ? { CurrencyRef: { value: "EUR" } } : {}),
      Line: inv.lines.map((l) => ({
        DetailType: "SalesItemLineDetail",
        Amount: num(l.amount),
        Description: l.description,
        SalesItemLineDetail: { ItemRef: { value: item }, Qty: 1, UnitPrice: num(l.amount) },
      })),
    };
    const r = await qb<{ Invoice: QbInvoice }>(ctx, "/invoice", { method: "POST", body: JSON.stringify(body) });
    return { id: r.Invoice.Id, customer: r.Invoice.CustomerRef?.value ?? customer };
  },
  async voidInvoice(ctx, remoteId) {
    const cur = (await qb<{ Invoice: QbInvoice }>(ctx, `/invoice/${remoteId}`)).Invoice;
    await qb(ctx, "/invoice?operation=void", { method: "POST", body: JSON.stringify({ Id: cur.Id, SyncToken: cur.SyncToken }) });
  },
  async pushPayment(ctx, inv, p, remote) {
    const customer = remote.customer ?? (await qb<{ Invoice: QbInvoice }>(ctx, `/invoice/${remote.id}`)).Invoice.CustomerRef.value;
    const deposit = ctx.bankAccount(inv.currency);
    const body = {
      CustomerRef: { value: customer },
      TotalAmt: num(p.amount),
      TxnDate: p.date,
      PaymentRefNum: p.txHash.slice(0, 21),
      PrivateNote: `Clearmark · ${p.token} on Arc · tx ${p.txHash}`,
      ...(deposit ? { DepositToAccountRef: { value: deposit } } : {}),
      ...(inv.currency === "EUR" ? { CurrencyRef: { value: "EUR" } } : {}),
      Line: [{ Amount: num(p.amount), LinkedTxn: [{ TxnId: remote.id, TxnType: "Invoice" }] }],
    };
    return (await qb<{ Payment: { Id: string } }>(ctx, "/payment", { method: "POST", body: JSON.stringify(body) })).Payment.Id;
  },
};

async function tokenRevoke(url: string, app: AppKeys, body: BodyInit, type: string) {
  await fetch(url, {
    method: "POST",
    headers: { authorization: basic(app), "content-type": type, accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

export const PROVIDERS: Record<AccountingProvider, Provider> = { xero: Xero, quickbooks: QuickBooks };

export const isProvider = (v: unknown): v is AccountingProvider => v === "xero" || v === "quickbooks";
