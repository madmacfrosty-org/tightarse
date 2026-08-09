/**
 * TrueLayer connection probe — answers the open questions in issues #3 and #11.
 *
 * Runs the auth code flow locally, then IMMEDIATELY probes how deep the
 * provider will let us read, using the original access token.
 *
 * Why the urgency: HSBC and First Direct only serve transactions older than
 * 90 days during roughly the first hour after consent, and only with the very
 * first access token. Refreshing before the deep read is done forfeits that
 * history permanently. So this probe never refreshes, and it times everything
 * relative to the moment of consent.
 *
 * SAFETY: this repo is public. The probe records *statistics about* the data
 * — field coverage, counts, date ranges — and never writes transaction
 * values, descriptions, merchants or account numbers to disk.
 *
 * Usage:
 *   TL_CLIENT_ID=... TL_CLIENT_SECRET=... npm run probe -w @tightarse/truelayer-probe
 *   TL_ENV=live ...   (default is sandbox)
 */

import { createServer } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

type Env = { auth: string; api: string; providers: string };

const ENVIRONMENTS: Record<string, Env> = {
  sandbox: {
    auth: "https://auth.truelayer-sandbox.com",
    api: "https://api.truelayer-sandbox.com",
    providers: "uk-cs-mock",
  },
  live: {
    auth: "https://auth.truelayer.com",
    api: "https://api.truelayer.com",
    providers: "uk-ob-all uk-oauth-all",
  },
};

const SCOPES = [
  "info",
  "accounts",
  "balance",
  "transactions",
  "direct_debits",
  "standing_orders",
  "offline_access",
].join(" ");

const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

/**
 * How far back to test, in months — **deepest first**, stopping at the first
 * success.
 *
 * The SCA exemption window is a race, and it is shared across every account on
 * the consent. Shallow-first would spend up to 6 sequential calls per account
 * discovering a boundary we can infer anyway, and with capture on it would
 * store the same transactions several times over.
 *
 * Deepest-first gets the maximum reachable history in one call when it works.
 * The exact boundary is then bracketed between the first success and the last
 * failure, which is precise enough.
 */
const DEFAULT_PROBE_DEPTHS_MONTHS = [36, 24, 18, 12, 6, 3];

/**
 * Override with TL_DEPTHS, deepest first, e.g. TL_DEPTHS=84,72,60,48,36
 *
 * The first live run showed the busiest account saturating exactly at the
 * 36-month boundary — its oldest transaction was the `from` date itself —
 * so the ceiling was ours, not First Direct's.
 */
const PROBE_DEPTHS_MONTHS = (() => {
  const raw = process.env["TL_DEPTHS"];
  if (!raw) return DEFAULT_PROBE_DEPTHS_MONTHS;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (parsed.length === 0) {
    console.error(`TL_DEPTHS="${raw}" parsed to nothing usable — expected e.g. 84,72,60`);
    process.exit(1);
  }
  return parsed.sort((a, b) => b - a);
})();

/**
 * A raw landing-zone record: exactly what the API returned, plus enough
 * provenance to reprocess it later without guessing.
 *
 * The deep-history window is one-shot per consent, so this is the copy that
 * makes a buggy transform survivable — you re-run the transform, not the bank
 * authorisation.
 */
interface RawRecord {
  endpoint: string;
  params: Record<string, string>;
  accountId: string | null;
  fetchedAt: string;
  httpStatus: number;
  /** The complete response envelope, not just `results`. */
  body: unknown;
}

const rawLog: RawRecord[] = [];
let captureEnabled = false;

function recordRaw(
  endpoint: string,
  params: Record<string, string>,
  accountId: string | null,
  httpStatus: number,
  body: unknown,
): void {
  if (!captureEnabled) return;
  rawLog.push({ endpoint, params, accountId, fetchedAt: new Date().toISOString(), httpStatus, body });
}

/**
 * Why a depth probe failed. The sandbox run showed these are not the same
 * thing and must not be conflated:
 *
 *  - "no-data"    the bank simply holds nothing that far back (invalid_date_range)
 *  - "permission" the SCA exemption window has closed (access_denied) — this is
 *                 the First Direct behaviour we actually care about
 */
type FailureKind = "no-data" | "permission" | "other" | null;

interface ProbeResult {
  depthMonths: number;
  from: string;
  ok: boolean;
  httpStatus: number;
  transactionCount: number | null;
  oldestTransaction: string | null;
  newestTransaction: string | null;
  errorCode: string | null;
  failureKind: FailureKind;
  secondsSinceConsent: number;
}

function classifyFailure(errorCode: string | null, httpStatus: number): FailureKind {
  if (errorCode === "invalid_date_range") return "no-data";
  if (errorCode === "access_denied" || httpStatus === 403) return "permission";
  return "other";
}

interface FieldCoverage {
  /** Fraction of transactions where the field was present and non-null. */
  [field: string]: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}.`);
    console.error("Set it in your shell — never in a file in this repo.");
    process.exit(1);
  }
  return v;
}

/**
 * Headless fallback for when you only have SSH to this machine.
 *
 * The redirect still goes to http://localhost:3000/callback — it must, because
 * the URI has to match what is registered with TrueLayer and what we send at
 * token exchange. Your browser will simply fail to load it. That is fine: the
 * authorisation code is sitting in the address bar, so paste the whole URL.
 *
 * Prefer the SSH tunnel (see README) — it needs no paste and the timing is
 * honest. Timing here includes however long you took to copy the URL across,
 * so elapsed values UNDER-report the true time since consent.
 */
async function readCodeFromStdin(expectedState: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Manual mode. After authorising, your browser will fail to load");
    console.log("the localhost redirect — that is expected.\n");
    console.log("Copy the FULL URL from the address bar and paste it here.");
    console.log("Be quick: the deep-history window is already running.\n");

    const answer = (await rl.question("redirect URL (or bare code): ")).trim();

    let code: string | null = null;
    let state: string | null = null;

    if (answer.includes("?") || answer.startsWith("http")) {
      const parsed = new URL(answer, `http://localhost:${REDIRECT_PORT}`);
      code = parsed.searchParams.get("code");
      state = parsed.searchParams.get("state");
      const error = parsed.searchParams.get("error");
      if (error) throw new Error(`Authorisation failed: ${error}`);
    } else {
      // Bare code pasted; no state to check against.
      code = answer;
    }

    if (!code) throw new Error("No authorisation code found in that input.");
    if (state !== null && state !== expectedState) {
      throw new Error("State mismatch — possible CSRF, aborting.");
    }
    if (state === null) {
      console.log("\nNote: bare code pasted, so CSRF state was not verified.");
    }
    return code;
  } finally {
    rl.close();
  }
}

/** Wait for the OAuth redirect and hand back the authorisation code. */
function awaitCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body style="font-family:system-ui;padding:3rem">
         <h1>${error ? "Connection failed" : "Connected"}</h1>
         <p>${error ? error : "Return to the terminal — the probe is running now, and it is time-sensitive."}</p>
         </body></html>`,
      );

      server.close();

      if (error) return reject(new Error(`Authorisation failed: ${error}`));
      if (state !== expectedState) return reject(new Error("State mismatch — possible CSRF, aborting."));
      if (!code) return reject(new Error("No authorisation code in callback."));
      resolve(code);
    });

    server.listen(REDIRECT_PORT);
    server.on("error", reject);
  });
}

/**
 * Deliberately NOT captured by recordRaw: the response contains the access and
 * refresh tokens. Raw landing-zone records are transaction data, never
 * credentials. Do not add a recordRaw call here.
 */
async function exchangeCode(env: Env, clientId: string, clientSecret: string, code: string) {
  const res = await fetch(`${env.auth}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      code,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

async function getAccounts(env: Env, token: string) {
  const res = await fetch(`${env.api}/data/v1/accounts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fetching accounts failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { results: Array<{ account_id: string; provider?: { display_name?: string } }> };
  recordRaw("/data/v1/accounts", {}, null, res.status, body);
  return body.results ?? [];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

/**
 * Probe one account at one depth. Returns metadata only — never the
 * transactions themselves.
 */
async function probeDepth(
  env: Env,
  token: string,
  accountId: string,
  depthMonths: number,
  consentAt: number,
): Promise<{ result: ProbeResult; transactions: Array<Record<string, unknown>> }> {
  const from = isoDate(monthsAgo(depthMonths));
  const to = isoDate(new Date());

  const res = await fetch(
    `${env.api}/data/v1/accounts/${accountId}/transactions?from=${from}&to=${to}`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  const secondsSinceConsent = Math.round((Date.now() - consentAt) / 1000);
  const base = { depthMonths, from, httpStatus: res.status, secondsSinceConsent };

  if (!res.ok) {
    let errorCode: string | null = null;
    try {
      const body = (await res.json()) as { error?: string };
      errorCode = body.error ?? null;
      // Failures are worth keeping too: they are the evidence of where the
      // SCA window closed, which is the whole point of the live run.
      recordRaw(`/data/v1/accounts/${accountId}/transactions`, { from, to }, accountId, res.status, body);
    } catch {
      errorCode = null;
    }
    return {
      result: {
        ...base,
        ok: false,
        transactionCount: null,
        oldestTransaction: null,
        newestTransaction: null,
        errorCode,
        failureKind: classifyFailure(errorCode, res.status),
      },
      transactions: [],
    };
  }

  const body = (await res.json()) as { results: Array<Record<string, unknown>> };
  recordRaw(`/data/v1/accounts/${accountId}/transactions`, { from, to }, accountId, res.status, body);
  const txns = body.results ?? [];
  const dates = txns
    .map((t) => (typeof t["timestamp"] === "string" ? (t["timestamp"] as string) : null))
    .filter((d): d is string => d !== null)
    .sort();

  return {
    result: {
      ...base,
      ok: true,
      transactionCount: txns.length,
      oldestTransaction: dates[0] ?? null,
      newestTransaction: dates[dates.length - 1] ?? null,
      errorCode: null,
      failureKind: null,
    },
    transactions: txns,
  };
}

/**
 * Pending transactions live on their own endpoint — they never appear on
 * /transactions. Whether First Direct populates it at all is worth knowing,
 * because it decides how much the pending→settled dedup logic has to handle.
 */
async function probePending(env: Env, token: string, accountId: string) {
  const res = await fetch(`${env.api}/data/v1/accounts/${accountId}/transactions/pending`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    let errorCode: string | null = null;
    try {
      const body = (await res.json()) as { error?: string };
      errorCode = body.error ?? null;
    } catch {
      errorCode = null;
    }
    return { supported: false, httpStatus: res.status, errorCode, count: 0, coverage: {} };
  }

  const body = (await res.json()) as { results: Array<Record<string, unknown>> };
  recordRaw(`/data/v1/accounts/${accountId}/transactions/pending`, {}, accountId, res.status, body);
  const txns = body.results ?? [];
  return {
    supported: true,
    httpStatus: res.status,
    errorCode: null,
    count: txns.length,
    coverage: fieldCoverage(txns),
  };
}

/**
 * How often does TrueLayer actually populate each field? This is the whole
 * point of the enrichment question in #3 — and it needs no transaction values.
 */
function fieldCoverage(transactions: Array<Record<string, unknown>>): FieldCoverage {
  if (transactions.length === 0) return {};
  const fields = new Set<string>();
  for (const t of transactions) for (const k of Object.keys(t)) fields.add(k);

  const coverage: FieldCoverage = {};
  for (const f of fields) {
    const present = transactions.filter((t) => {
      const v = t[f];
      return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
    }).length;
    coverage[f] = Number((present / transactions.length).toFixed(3));
  }
  return coverage;
}

/** Do provider transaction ids stay stable between pending and settled? */
function pendingSettledStats(transactions: Array<Record<string, unknown>>) {
  const byStatus: Record<string, number> = {};
  for (const t of transactions) {
    const s = typeof t["transaction_type"] === "string" ? (t["transaction_type"] as string) : "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const ids = transactions
    .map((t) => t["transaction_id"])
    .filter((id): id is string => typeof id === "string");
  return {
    byType: byStatus,
    totalWithIds: ids.length,
    distinctIds: new Set(ids).size,
    duplicateIds: ids.length - new Set(ids).size,
  };
}

async function main() {
  const clientId = requireEnv("TL_CLIENT_ID");
  const clientSecret = requireEnv("TL_CLIENT_SECRET");
  const envName = process.env["TL_ENV"] === "live" ? "live" : "sandbox";
  const env = ENVIRONMENTS[envName]!;

  console.log(`\nTrueLayer probe — ${envName}\n`);
  if (envName === "live") {
    console.log("LIVE MODE. Deep history is available only once per consent.");
    console.log("Do not interrupt this run; do not refresh the token afterwards.\n");
  }

  const state = randomBytes(16).toString("hex");
  const authUrl =
    `${env.auth}/?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&providers=${encodeURIComponent(env.providers)}` +
    `&state=${state}`;

  const manual = process.env["TL_MANUAL"] === "1";
  const capture = process.env["TL_CAPTURE"] === "1";
  captureEnabled = capture;

  if (capture) {
    console.log("TL_CAPTURE=1 — raw responses WILL be written to disk this run.\n");
  }

  console.log("Open this URL and connect the account:\n");
  console.log(authUrl + "\n");

  const code = manual
    ? await readCodeFromStdin(state)
    : await (async () => {
        console.log(`Waiting for the redirect on ${REDIRECT_URI} ...`);
        console.log("(SSH-only? Either forward the port — see README — or re-run with TL_MANUAL=1)\n");
        return awaitCallback(state);
      })();

  // The clock starts here. Everything below is inside the SCA exemption window.
  const consentAt = Date.now();
  console.log("Got the authorisation code. Exchanging, then probing immediately.\n");

  const tokens = await exchangeCode(env, clientId, clientSecret, code);
  console.log(`access_token acquired (expires in ${tokens.expires_in}s)`);
  console.log(`refresh_token ${tokens.refresh_token ? "present" : "ABSENT — check the offline_access scope"}\n`);

  const accounts = await getAccounts(env, tokens.access_token);
  console.log(`${accounts.length} account(s) found\n`);

  const findings: Record<string, unknown> = {
    environment: envName,
    probedAt: new Date().toISOString(),
    // Manual mode starts the clock at paste time, not at the bank's redirect,
    // so secondsSinceConsent under-reports true elapsed time.
    captureMode: manual ? "manual-paste" : "local-callback",
    timingReliable: !manual,
    accountCount: accounts.length,
    refreshTokenPresent: Boolean(tokens.refresh_token),
    accessTokenExpiresIn: tokens.expires_in,
    accounts: [] as unknown[],
  };

  let accountIndex = 0;
  for (const account of accounts) {
    accountIndex += 1;
    const elapsed = Math.round((Date.now() - consentAt) / 1000);
    console.log(
      `[${accountIndex}/${accounts.length}] t+${elapsed}s  ${account.account_id} (${account.provider?.display_name ?? "unknown provider"})`,
    );
    const results: ProbeResult[] = [];
    let deepest: Array<Record<string, unknown>> = [];

    for (const depth of PROBE_DEPTHS_MONTHS) {
      const { result, transactions } = await probeDepth(
        env,
        tokens.access_token,
        account.account_id,
        depth,
        consentAt,
      );
      results.push(result);

      const status = result.ok
        ? `ok    ${String(result.transactionCount).padStart(5)} txns, oldest ${result.oldestTransaction ?? "n/a"}`
        : `FAIL  ${result.httpStatus} ${result.errorCode ?? ""} [${result.failureKind}]`;
      console.log(`  ${String(depth).padStart(2)}mo (t+${result.secondsSinceConsent}s)  ${status}`);

      if (result.ok) {
        // Deepest-first, so the first success is the deepest reachable.
        deepest = transactions;
        break;
      }

      // Keep stepping shallower. The reason still matters: "permission" means
      // the SCA window has shut and history we could have had is now lost,
      // whereas "no-data" is simply the bank's history ending.
      if (result.failureKind === "permission") {
        console.log("    ^ SCA window appears closed — deep history no longer reachable");
      }
    }

    const pending = await probePending(env, tokens.access_token, account.account_id);
    console.log(
      `  pending endpoint: ${pending.supported ? `${pending.count} txns` : `unsupported (${pending.httpStatus} ${pending.errorCode ?? ""})`}`,
    );

    (findings["accounts"] as unknown[]).push({
      accountId: account.account_id,
      provider: account.provider?.display_name ?? null,
      probes: results,
      pending,
      fieldCoverage: fieldCoverage(deepest),
      transactionStats: pendingSettledStats(deepest),
    });

    console.log("");
  }

  await mkdir("out", { recursive: true });
  const path = `out/findings-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(findings, null, 2));

  console.log(`Findings written to ${path}`);
  console.log("Contains statistics only — no transaction values, descriptions or account numbers.\n");

  if (capture) {
    // Opt-in only. Deep history is available once per consent, so this exists
    // to avoid spending a second bank authorisation purely to re-fetch what we
    // already had in hand. It is real financial data: 0600, gitignored, and it
    // should move into the ledger and be deleted as soon as that exists.
    const rawPath = `out/raw-${Date.now()}.json`;
    const envelope = {
      captureVersion: 1,
      capturedAt: new Date().toISOString(),
      environment: envName,
      /** Consent this came from. Distinguishes captures if you re-consent. */
      consentAt: new Date(consentAt).toISOString(),
      recordCount: rawLog.length,
      records: rawLog,
    };
    await writeFile(rawPath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    console.log(`RAW RESPONSES written to ${rawPath} (mode 0600, ${rawLog.length} records).`);
    console.log("Complete response envelopes with endpoint, params and fetch time —");
    console.log("this is the S3 landing-zone record, ready to transform from.\n");
    console.log("It is real financial data. Gitignored, but delete it once the");
    console.log("ledger exists and it has been imported.\n");
  }

  console.log("REMINDER: do not refresh this token if you still need deeper history.");
}

main().catch((err: unknown) => {
  console.error("\nProbe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
