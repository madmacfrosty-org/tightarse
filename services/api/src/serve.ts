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
 *
 * It calls `route` rather than reimplementing it. It used to have its own copy —
 * its own range defaults, its own path matching, its own response shapes — which
 * is the thing testing.md warns about: a copy passes forever while the real code
 * rots, and the two had already drifted. Everything below is transport.
 */

import { createServer } from "node:http";
import { DynamoStore } from "@tightarse/dynamodb";
import { route, type ApiDeps } from "./handler.js";

const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = "127.0.0.1";

const tenantId = process.env["TENANT"] ?? "frost";
const tableName = process.env["TABLE"];
if (!tableName) {
  console.error("Missing TABLE");
  process.exit(1);
}

const ledger = new DynamoStore({ tableName, region: process.env["AWS_REGION"] ?? "eu-west-1" });

/**
 * Log what a failure actually was, before `route` hides it.
 *
 * The handler answers a 500 with "Internal error" on purpose — the underlying
 * message can carry key material and table structure, and it is going to a
 * browser. That is right in production and useless on a laptop, so the cause is
 * logged here, at the seam, rather than by giving this file its own error
 * handling to drift out of step.
 */
async function logged<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`${what} failed:`, err);
    throw err;
  }
}

const deps: ApiDeps = {
  ledger: {
    listRange: (tenant, range) => logged("listRange", () => ledger.listRange(tenant, range)),
    listAccounts: (tenant) => logged("listAccounts", () => ledger.listAccounts(tenant)),
  },
};

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    const result = await route(deps, {
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      // The claim a verified token would have carried, fabricated from an
      // environment variable. This is the whole reason the file says never
      // deploy it: the real handler's first act is to refuse a request that
      // does not carry one of these.
      requestContext: { authorizer: { jwt: { claims: { "custom:tenant": tenantId } } } },
    });

    res.statusCode = result.statusCode;
    // The browser is on a different origin in development; API Gateway handles
    // this in the deployed stack, so it is transport rather than logic.
    res.setHeader("access-control-allow-origin", "*");
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.end(result.body);
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`dev api on http://${HOST}:${PORT}  tenant=${tenantId}`);
  console.log(`  /summary  /transactions  /accounts   (?from=&to=)`);
  console.log(`\nNo auth. Loopback only. Never deploy this.`);
});
