import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoText } from "@/lib/arc";
import { toUnits } from "@/lib/money";
import type { Hex } from "@/lib/types";

// The store reads its file path when it loads, so point it at a scratch file before importing it.
const dir = mkdtempSync(path.join(tmpdir(), "cm-acct-"));
process.env.CLEARMARK_DATA_FILE = path.join(dir, "db.json");
process.env.CLEARMARK_SECRET_KEY = "test-secret-key";

const { read, write } = await import("@/lib/store");
const { createInvoice, ensureMerchant, recordTransfer, voidInvoice } = await import("@/lib/ledger");
const { seal, sealKey, unseal } = await import("@/lib/seal");
const sync = await import("@/lib/accounting/sync");

const M = "0x4f2c000000000000000000000000000000091ae0" as Hex;
const now = new Date();
const ORIGIN = "https://clearmark.example";

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let routes: (c: Call) => unknown;

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? safeJson(init.body) : init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    const c = { method: init.method ?? "GET", url: String(url), body };
    calls.push(c);
    const out = routes(c);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

let tx = 0;
const transfer = (amount: string, memoId: Hex) => ({
  source: "chain" as const,
  txHash: `0x${(++tx).toString(16).padStart(64, "0")}` as Hex,
  logIndex: 0,
  blockNumber: BigInt(tx),
  timestamp: now.toISOString(),
  from: "0x9a1d00000000000000000000000000000000c07b" as Hex,
  to: M,
  amount: toUnits(amount),
  memoId,
  memoData: memoText({ pay: "full" }),
});

async function reset(provider: "xero" | "quickbooks", expiresIn = 3600_000) {
  calls = [];
  await write((db) => {
    for (const k of Object.keys(db)) delete (db as unknown as Record<string, unknown>)[k];
    Object.assign(db, { version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });
    ensureMerchant(db, M, now, 1n);
    sync.saveApp(db, M, provider, { clientId: "client-123", clientSecret: "shh-secret", sandbox: provider === "quickbooks" });
    const l = sync.linkOf(db, M, provider);
    const key = sealKey(db);
    l.connection = {
      tenantId: provider === "xero" ? "tenant-1" : "4620816365",
      tenantName: "Test Co",
      accessToken: seal("access-1", key),
      refreshToken: seal("refresh-1", key),
      accessExpires: Date.now() + expiresIn,
      connectedAt: now.toISOString(),
    };
    l.settings = { salesAccount: provider === "xero" ? "200" : "79", bankAccount: { USDC: "bank-1" } };
  });
}

async function invoiceWithPayment(amount = "250") {
  return write((db) => {
    const inv = createInvoice(db, M, { title: "Phone fix", customerName: "Saint Mike", amount: "250", tolerance: "0", dueDate: "2099-01-01" }, now);
    recordTransfer(db, transfer(amount, inv.memoId), now);
    return inv;
  });
}

describe("Xero sync", () => {
  beforeEach(() => {
    routes = (c) => {
      if (c.url.includes("/Invoices?")) return { Invoices: [] };
      if (c.method === "POST" && c.url.endsWith("/Invoices")) return { Invoices: [{ InvoiceID: "x-inv-1", Contact: { ContactID: "x-c-1" } }] };
      if (c.method === "POST" && /\/Invoices\/x-inv-\d$/.test(c.url)) return { Invoices: [{ InvoiceID: "x-inv-1" }] };
      if (c.method === "PUT" && c.url.endsWith("/Payments")) return { Payments: [{ PaymentID: "x-pay-1" }] };
      if (c.url.includes("identity.xero.com/connect/token")) return { access_token: "access-2", refresh_token: "refresh-2", expires_in: 1800 };
      return new Response(JSON.stringify({ Message: "unexpected " + c.url }), { status: 500 });
    };
  });

  it("sends an invoice and its payment once, with the right fields", async () => {
    await reset("xero");
    const inv = await invoiceWithPayment();
    const r = await sync.syncAccounting(M, "xero", ORIGIN);
    expect(r).toMatchObject({ invoices: 1, payments: 1, issues: 0, more: false });

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/Invoices"))!;
    const sent = (post.body as { Invoices: Record<string, unknown>[] }).Invoices[0];
    expect(sent).toMatchObject({
      Type: "ACCREC",
      InvoiceNumber: inv.number,
      CurrencyCode: "USD",
      Status: "AUTHORISED",
      Contact: { Name: "Saint Mike" },
      LineItems: [{ Description: "Phone fix", Quantity: 1, UnitAmount: 250, AccountCode: "200" }],
      Url: `${ORIGIN}/pay/${inv.id}`,
    });
    const pay = calls.find((c) => c.url.endsWith("/Payments"))!;
    expect((pay.body as { Payments: Record<string, unknown>[] }).Payments[0]).toMatchObject({ Invoice: { InvoiceID: "x-inv-1" }, Account: { AccountID: "bank-1" }, Amount: 250 });
    expect(post.url.startsWith("https://api.xero.com/api.xro/2.0")).toBe(true);

    calls = [];
    expect(await sync.syncAccounting(M, "xero", ORIGIN)).toMatchObject({ invoices: 0, payments: 0 });
    expect(calls).toEqual([]);
  });

  it("voids an invoice that was voided in Clearmark", async () => {
    await reset("xero");
    const inv = await write((db) => createInvoice(db, M, { title: "Repair", customerName: "Ada", amount: "40", tolerance: "0", dueDate: "2099-01-01" }, now));
    await sync.syncAccounting(M, "xero", ORIGIN);
    await write((db) => voidInvoice(db, M, inv.id, "Customer cancelled", now));
    calls = [];
    const r = await sync.syncAccounting(M, "xero", ORIGIN);
    expect(r.voided).toBe(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/Invoices/x-inv-1"), body: { Invoices: [{ InvoiceID: "x-inv-1", Status: "VOIDED" }] } });
  });

  it("refreshes an expired token and saves the rotated refresh token", async () => {
    await reset("xero", -1000);
    await invoiceWithPayment();
    await sync.syncAccounting(M, "xero", ORIGIN);
    expect(calls[0].url).toBe("https://identity.xero.com/connect/token");
    expect(calls[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    const db = await read();
    const c = sync.linkOf(db, M, "xero").connection!;
    expect(unseal(c.refreshToken, sealKey(db))).toBe("refresh-2");
    expect(c.accessExpires).toBeGreaterThan(Date.now());
  });

  it("records a rejected invoice as an issue and keeps going", async () => {
    await reset("xero");
    await invoiceWithPayment();
    routes = (c) =>
      c.url.includes("/Invoices?")
        ? { Invoices: [] }
        : new Response(JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: "Account code '200' is not a valid code." }] }] }), { status: 400 });
    const r = await sync.syncAccounting(M, "xero", ORIGIN);
    expect(r.issues).toBe(1);
    const st = sync.linkStatus(await read(), M, "xero");
    expect(st.issues[0].message).toBe("Account code '200' is not a valid code.");
    expect(st.syncing).toBe(false);
  });

  it("only sends invoices issued on or after the start date", async () => {
    await reset("xero");
    await write((db) => (sync.linkOf(db, M, "xero").settings.since = "2999-01-01"));
    await invoiceWithPayment();
    expect(await sync.syncAccounting(M, "xero", ORIGIN)).toMatchObject({ invoices: 0, payments: 0 });
  });

  it("never exposes secrets or tokens in the status", async () => {
    await reset("xero");
    const s = JSON.stringify(sync.linkStatus(await read(), M, "xero"));
    for (const secret of ["shh-secret", "access-1", "refresh-1", "v1."]) expect(s).not.toContain(secret);
    expect(s).toContain("client-123");
  });
});

describe("QuickBooks sync", () => {
  it("creates the item and customer, then the invoice and a payment linked to it", async () => {
    await reset("quickbooks");
    await invoiceWithPayment();
    routes = (c) => {
      if (c.url.includes("/query?")) return { QueryResponse: {} };
      if (c.url.includes("/item?")) return { Item: { Id: "it-1" } };
      if (c.url.includes("/customer?")) return { Customer: { Id: "cu-1", DisplayName: "Saint Mike" } };
      if (c.url.includes("/invoice?")) return { Invoice: { Id: "qi-1", SyncToken: "0", CustomerRef: { value: "cu-1" } } };
      if (c.url.includes("/payment?")) return { Payment: { Id: "qp-1" } };
      return new Response("{}", { status: 500 });
    };
    const r = await sync.syncAccounting(M, "quickbooks", ORIGIN);
    expect(r).toMatchObject({ invoices: 1, payments: 1, issues: 0 });
    expect(calls.every((c) => c.url.startsWith("https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365/") && c.url.includes("minorversion=75"))).toBe(true);
    const item = calls.find((c) => c.url.includes("/item?"))!;
    expect(item.body).toEqual({ Name: "Clearmark", Type: "Service", IncomeAccountRef: { value: "79" } });
    const inv = calls.find((c) => c.url.includes("/invoice?"))!.body as Record<string, unknown>;
    expect(inv).toMatchObject({ CustomerRef: { value: "cu-1" }, DocNumber: "INV-10001", Line: [{ Amount: 250, SalesItemLineDetail: { ItemRef: { value: "it-1" }, Qty: 1 } }] });
    const pay = calls.find((c) => c.url.includes("/payment?"))!.body as Record<string, unknown>;
    expect(pay).toMatchObject({ CustomerRef: { value: "cu-1" }, TotalAmt: 250, DepositToAccountRef: { value: "bank-1" }, Line: [{ Amount: 250, LinkedTxn: [{ TxnId: "qi-1", TxnType: "Invoice" }] }] });
    expect(String(pay.PaymentRefNum).length).toBeLessThanOrEqual(21);
    const db = await read();
    expect(sync.linkOf(db, M, "quickbooks").remote).toMatchObject({ item: "it-1", customers: { "Saint Mike|USD": "cu-1" } });
  });
});

describe("connecting", () => {
  it("refuses a callback whose state didn't start in this browser", async () => {
    await reset("xero");
    const { url, state } = await sync.beginConnect(M, "xero", `${ORIGIN}/api/accounting/xero/callback`);
    expect(url).toContain("login.xero.com/identity/connect/authorize");
    expect(url).toContain("client_id=client-123");
    expect(url).toContain(encodeURIComponent(`${ORIGIN}/api/accounting/xero/callback`));
    const params = new URLSearchParams({ code: "abc", state });
    await expect(sync.finishConnect(M, "xero", params, `${ORIGIN}/api/accounting/xero/callback`, "other-state")).rejects.toThrow(/expired or didn't start here/);
    // The state is single use.
    await expect(sync.finishConnect(M, "xero", params, `${ORIGIN}/api/accounting/xero/callback`, state)).rejects.toThrow(/expired or didn't start here/);
  });

  it("finishes a sign-in: exchanges the code, finds the organisation and stores tokens sealed", async () => {
    await reset("xero");
    await write((db) => (sync.linkOf(db, M, "xero").connection = null));
    routes = (c) => {
      if (c.url.includes("connect/token")) return { access_token: "acc-new", refresh_token: "ref-new", expires_in: 1800 };
      if (c.url === "https://api.xero.com/connections") return [{ id: "conn-1", tenantId: "t-9", tenantType: "ORGANISATION", tenantName: "Demo Ltd" }];
      return new Response("{}", { status: 500 });
    };
    const redirect = `${ORIGIN}/api/accounting/xero/callback`;
    const { state } = await sync.beginConnect(M, "xero", redirect);
    calls = [];
    await sync.finishConnect(M, "xero", new URLSearchParams({ code: "abc", state }), redirect, state);
    expect(calls[0].body).toMatchObject({ grant_type: "authorization_code", code: "abc", redirect_uri: redirect });
    const db = await read();
    const l = sync.linkOf(db, M, "xero");
    expect(l.connection).toMatchObject({ tenantId: "t-9", tenantName: "Demo Ltd", connectionId: "conn-1" });
    expect(l.connection!.accessToken).not.toContain("acc-new");
    expect(unseal(l.connection!.accessToken, sealKey(db))).toBe("acc-new");
    expect(l.settings.since).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("asks for the secret again when the client ID changes", async () => {
    await reset("xero");
    await expect(write((db) => sync.saveApp(db, M, "xero", { clientId: "client-456" }))).rejects.toThrow(/needs its client secret/);
  });
});
