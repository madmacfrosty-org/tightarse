/**
 * Run the aggregation against a real ledger and print it.
 *
 * The API is not deployed yet — this exercises the same pure functions the
 * handler uses, so the numbers here are the numbers the dashboard will show.
 *
 *   TENANT=frost TABLE=<name> node dist/report.js [from] [to]
 */

import { Ledger } from "@tightarse/ledger";
import { summarise, type EnrichmentRow, type LedgerRow } from "./aggregate.js";

const money = (minor: number, currency: string | null): string => {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const symbol = currency === "GBP" ? "£" : `${currency ?? ""} `;
  return `${sign}${symbol}${(abs / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`;
};

async function main() {
  const tenantId = process.env["TENANT"] ?? "frost";
  const tableName = process.env["TABLE"];
  if (!tableName) {
    console.error("Missing TABLE");
    process.exit(1);
  }

  const from = process.argv[2] ?? "2021-01-01";
  const to = process.argv[3] ?? new Date().toISOString().slice(0, 10);

  const ledger = new Ledger({ tableName, region: process.env["AWS_REGION"] ?? "eu-west-1" });
  const { transactions, enrichments } = await ledger.listRange(tenantId, { from, to });

  const s = summarise(
    transactions as unknown as LedgerRow[],
    enrichments as unknown as EnrichmentRow[],
    { from, to },
  );

  console.log(`\n${from} to ${to}   ${s.transactionCount} transactions   ${s.currency}\n`);
  console.log(`  income   ${money(s.income, s.currency).padStart(14)}`);
  console.log(`  spend    ${money(s.spend, s.currency).padStart(14)}`);
  console.log(`  net      ${money(s.net, s.currency).padStart(14)}`);

  console.log(`\nby provider category:`);
  for (const c of s.byCategory) {
    console.log(
      `  ${c.category.padEnd(18)} ${money(c.total, s.currency).padStart(14)}  ${String(c.count).padStart(5)}` +
        (c.provisional ? "  (provider)" : ""),
    );
  }

  console.log(`\nby month (last 12 shown):`);
  for (const m of s.byMonth.slice(-12)) {
    console.log(
      `  ${m.month}  in ${money(m.income, s.currency).padStart(12)}` +
        `  out ${money(m.spend, s.currency).padStart(13)}` +
        `  net ${money(m.net, s.currency).padStart(12)}`,
    );
  }

  console.log(`\ncategorised by our own agent: ${s.enrichedCount} of ${s.transactionCount}`);
  if (!s.internalTransfersNetted) {
    console.log(
      `\nNOTE: movement between your own accounts is not yet removed (#12),\n` +
        `      so both income and spend are overstated by the same amount.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error("report failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
