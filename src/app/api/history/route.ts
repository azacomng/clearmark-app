import { handle, json, requireMerchant } from "@/lib/http";
import { fmt } from "@/lib/money";
import { historyRows } from "@/lib/service";
import { read } from "@/lib/store";

export const GET = handle(async (req: Request) => {
  const m = await requireMerchant();
  const rows = historyRows(await read(), m);
  const url = new URL(req.url);
  if (url.searchParams.get("format") !== "csv") return json({ rows });
  const origin = url.origin;
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    ["date_utc", "type", "counterparty", "wallet", "invoice", "status", "amount_usdc", "tx_hash", "receipt_url", "source"].join(","),
    ...rows.map((r) =>
      [r.at, r.kind === "in" ? "received" : "refund", r.counterparty, r.address, r.invoiceNumber ?? "", r.status, fmt(r.amount).replace(/,/g, ""), r.txHash ?? "", origin + r.receipt, r.source]
        .map((x) => esc(String(x)))
        .join(","),
    ),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="clearmark-history-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});
