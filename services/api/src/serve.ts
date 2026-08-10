/**
 * Local development server.
 *
 * Serves the same aggregation the deployed handler will, without API Gateway or
 * Cognito, so the dashboard can be built and judged against real data before
 * anything is deployed.
 *
 * NOT for deployment. There is no authentication at all: the household is taken
 * from an environment variable rather than a verified token, which is precisely
 * the hole the real handler exists to avoid. It binds to loopback only.
 *
 *   TENANT=frost TABLE=<name> node dist/serve.js
 */

import { createServer } from "node:http";
import { Ledger } from "@tightarse/ledger";
import { mergeEnrichments, summarise, type EnrichmentRow, type LedgerRow } from "./aggregate.js";

const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = "127.0.0.1";

const tenantId = process.env["TENANT"] ?? "frost";
const tableName = process.env["TABLE"];
if (!tableName) {
  console.error("Missing TABLE");
  process.exit(1);
}

const ledger = new Ledger({ tableName, region: process.env["AWS_REGION"] ?? "eu-west-1" });

function defaultRange() {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return { from, to };
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const range = {
      from: url.searchParams.get("from") ?? defaultRange().from,
      to: url.searchParams.get("to") ?? defaultRange().to,
    };

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");

    try {
      if (url.pathname === "/accounts") {
        res.end(JSON.stringify({ accounts: await ledger.listAccounts(tenantId) }));
        return;
      }

      const { transactions, enrichments } = await ledger.listRange(tenantId, range);
      const txns = transactions as unknown as LedgerRow[];
      const enr = enrichments as unknown as EnrichmentRow[];

      if (url.pathname === "/summary") {
        res.end(JSON.stringify(summarise(txns, enr, range)));
        return;
      }
      if (url.pathname === "/transactions") {
        const limit = Number(url.searchParams.get("limit") ?? "200");
        res.end(
          JSON.stringify({ range, transactions: mergeEnrichments(txns, enr).slice(0, limit) }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `No route for ${url.pathname}` }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`dev api on http://${HOST}:${PORT}  tenant=${tenantId}`);
  console.log(`  /summary  /transactions  /accounts   (?from=&to=)`);
  console.log(`\nNo auth. Loopback only. Never deploy this.`);
});
