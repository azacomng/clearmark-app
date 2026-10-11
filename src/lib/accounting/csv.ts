// File exports in the shapes Xero and QuickBooks Online import. The merchant downloads them here and
// uploads them in their accounting tool: no connection or keys needed.
//
//   Xero        Sales invoices: Business > Invoices > Import (Xero's sales invoice template columns)
//               Transactions:   a bank account > Import a statement (Date, Amount, Payee, Description, Reference)
//   QuickBooks  Invoices:       Settings > Import data > Invoices (QuickBooks' sample columns)
//               Transactions:   Banking > Upload transactions (Date, Description, Amount)

import { money, type BookInvoice, type BookTxn } from "./model";

export type DateFormat = "iso" | "dmy" | "mdy";

export function formatDate(iso: string, f: DateFormat): string {
  const [y, m, d] = iso.split("-");
  return f === "dmy" ? `${d}/${m}/${y}` : f === "mdy" ? `${m}/${d}/${y}` : iso;
}

const cell = (v: string) => {
  // Cells that start with = + - @ are formulas to a spreadsheet; a leading quote keeps them text.
  // Amounts are written separately and may be negative.
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csv(header: string[], rows: (string | { raw: string })[][]): string {
  const line = (r: (string | { raw: string })[]) => r.map((v) => (typeof v === "string" ? cell(v) : v.raw)).join(",");
  return [header.join(","), ...rows.map(line)].join("\r\n") + "\r\n";
}

const amt = (u: bigint) => ({ raw: money(u) });

export const XERO_INVOICE_HEADER = [
  "*ContactName", "EmailAddress", "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion",
  "POPostalCode", "POCountry", "*InvoiceNumber", "Reference", "*InvoiceDate", "*DueDate", "Total", "InventoryItemCode",
  "*Description", "*Quantity", "*UnitAmount", "Discount", "*AccountCode", "*TaxType", "TaxAmount", "TrackingName1",
  "TrackingOption1", "TrackingName2", "TrackingOption2", "Currency", "BrandingTheme",
];

export interface XeroCsvOptions {
  dateFormat: DateFormat;
  /** Revenue account code in the merchant's chart of accounts, e.g. 200. */
  accountCode: string;
  /** Tax rate name as Xero shows it, e.g. "Tax Exempt" or "No VAT". */
  taxType: string;
}

/** One row per invoice line; rows with the same invoice number make one invoice. Voided invoices are left out. */
export function xeroInvoicesCsv(invoices: BookInvoice[], o: XeroCsvOptions): string {
  const rows = invoices
    .filter((i) => !i.voided)
    .flatMap((i) =>
      i.lines.map((l) => [
        i.customerName, i.customerEmail ?? "", "", "", "", "", "", "", "", "",
        i.number, `Clearmark ${i.id}`, formatDate(i.issueDate, o.dateFormat), formatDate(i.dueDate, o.dateFormat), "", "",
        l.description, "1", amt(l.amount), "", o.accountCode, o.taxType, "", "", "", "", "", i.currency, "",
      ]),
    );
  return csv(XERO_INVOICE_HEADER, rows);
}

export const QB_INVOICE_HEADER = [
  "*InvoiceNo", "*Customer", "*InvoiceDate", "*DueDate", "Terms", "Location", "Memo", "Item(Product/Service)",
  "ItemDescription", "ItemQuantity", "ItemRate", "*ItemAmount", "Currency",
];

export interface QbCsvOptions {
  dateFormat: DateFormat;
  /** Product/Service name in QuickBooks the lines are booked to, e.g. "Services". */
  item: string;
}

export function quickbooksInvoicesCsv(invoices: BookInvoice[], o: QbCsvOptions): string {
  const rows = invoices
    .filter((i) => !i.voided)
    .flatMap((i) =>
      i.lines.map((l) => [
        i.number, i.customerName, formatDate(i.issueDate, o.dateFormat), formatDate(i.dueDate, o.dateFormat), "", "",
        `${i.title} · Clearmark ${i.id}`, o.item, l.description, "1", amt(l.amount), amt(l.amount), i.currency,
      ]),
    );
  return csv(QB_INVOICE_HEADER, rows);
}

export function xeroStatementCsv(txns: BookTxn[], f: DateFormat): string {
  return csv(
    ["Date", "Amount", "Payee", "Description", "Reference"],
    txns.map((t) => [formatDate(t.date, f), amt(t.amount), t.payee, t.description, t.reference]),
  );
}

export function quickbooksStatementCsv(txns: BookTxn[], f: DateFormat): string {
  return csv(
    ["Date", "Description", "Amount"],
    txns.map((t) => [formatDate(t.date, f), [t.payee, t.description, t.reference].filter(Boolean).join(" · "), amt(t.amount)]),
  );
}
