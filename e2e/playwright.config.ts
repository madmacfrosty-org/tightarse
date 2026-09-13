import { defineConfig, devices } from "@playwright/test";

/**
 * Stage 5, and the only stage whose subject is a deployment rather than a
 * package. See `docs/conventions/test-strategy.md`.
 *
 * Everything here exists to make the blast radius smaller than a browser's
 * natural one. A real browser with real network access goes wherever a page
 * sends it, and this suite runs against an account holding a household's
 * dashboard software, so the guards are structural rather than advisory.
 */

/** Dev's CloudFront distribution. `config.ts:218`. */
const DEV_SITE = "https://d235jlz4kj7lqs.cloudfront.net";

/**
 * The sites this suite may be pointed at. Dev, and nothing else.
 *
 * Prod's URL sits in the same config file as dev's, so "point it at dev" is a
 * decision that can be got wrong silently. Overridable towards something on
 * this list and nowhere else — an environment variable that could reach prod
 * would make every guard below decorative.
 */
const ALLOWED_SITES = [DEV_SITE] as const;

const baseURL = process.env["E2E_BASE_URL"] ?? DEV_SITE;
if (!ALLOWED_SITES.includes(baseURL as (typeof ALLOWED_SITES)[number])) {
  throw new Error(
    `E2E_BASE_URL must be one of ${ALLOWED_SITES.join(", ")} — refusing to drive a browser at ${baseURL}`,
  );
}

/**
 * Where the browser may go, at all — derived from the deployment under test.
 *
 * The dashboard talks to three origins: itself, its API, and Cognito's hosted
 * UI. The first version of this file listed them, and the list was wrong: the
 * API was missing, so every call the page made was aborted and the dashboard
 * rendered "Failed to fetch" — a confinement so tight the application could not
 * run, which looks exactly like a broken deployment.
 *
 * Read from `/config.json` instead, which is what the application itself reads
 * (`web/src/config.ts:38`). The allow-list is then whatever this deployment
 * actually uses. It cannot drift when an API Gateway id changes, and it cannot
 * be widened by editing a constant — only by pointing the suite at a different
 * site, which the check above governs.
 */
async function allowedOrigins(site: string): Promise<string[]> {
  const res = await fetch(`${site}/config.json`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Could not read ${site}/config.json (${res.status}) — cannot establish where the browser may go`);
  }
  const { apiUrl, hostedUiDomain } = (await res.json()) as {
    apiUrl?: string;
    hostedUiDomain?: string;
  };
  if (!apiUrl || !hostedUiDomain) {
    throw new Error("config.json is missing apiUrl or hostedUiDomain");
  }
  return [site, new URL(apiUrl).origin, `https://${hostedUiDomain}`];
}

export const ALLOWED_ORIGINS: readonly string[] = await allowedOrigins(baseURL);

export default defineConfig({
  testDir: "./tests",
  // The agents in #169 default to these, so nothing needs re-pointing when they
  // are regenerated.
  outputDir: "./test-results",
  // One at a time, because the environment cannot take more.
  //
  // The dev account's Lambda concurrency limit is **5**, and one dashboard load
  // fires exactly five reads in a single `Promise.all` — summary, accounts,
  // transactions, balances, books. A second worker loading a page at the same
  // moment asks for ten, five are throttled, and API Gateway returns 503 with
  // no body. That reads as a broken API: the Lambda logs nothing because it was
  // never invoked, and `Errors` stays at zero while `Throttles` climbs.
  //
  // Parallelism here is not worth the cost of a suite that fails for reasons
  // that have nothing to do with the software. Retries absorb a throttle from
  // anything else that happens to run.
  fullyParallel: false,
  workers: 1,
  // A deployed environment is shared. A test that only passes alone has found
  // something, and `.only` left in a commit silently stops running the rest.
  forbidOnly: !!process.env["CI"],
  // Retried everywhere, not only in CI: a throttle is transient and says nothing
  // about the dashboard, and the limit above leaves no headroom for whatever
  // else the account is doing.
  retries: 2,
  reporter: process.env["CI"] ? [["blob"], ["list"]] : [["html", { open: "never" }], ["list"]],
  use: {
    baseURL,
    // Kept only for a failure. A trace records what was on screen, and what is
    // on screen here is a ledger — synthetic in dev, and the habit matters more
    // than this one environment.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    // Signs in once; every other project reuses the state it saves.
    { name: "setup", testDir: "./setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "./.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
});
