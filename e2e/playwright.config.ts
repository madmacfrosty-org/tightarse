import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
 * The Vite dev server, in both the spellings of loopback it can be reached by.
 *
 * `packages/web` runs `vite --host 127.0.0.1` on the port `vite.config.ts`
 * pins, and Cognito and the API allow both spellings in every environment that
 * is not prod (`data-stack.ts:214`, `api-stack.ts:102`). Which one the browser
 * has to use is therefore a choice, and both are listed so that choosing wrong
 * fails on a callback mismatch rather than on this file.
 *
 * This is here so verifying a change is a page reload rather than a merge and a
 * twenty-minute deploy. It is not a second environment: the page is local, the
 * API and the identity provider it talks to are still dev's.
 */
const LOCAL_SITES = ["http://127.0.0.1:5173", "http://localhost:5173"] as const;

/**
 * The sites this suite may be pointed at. Dev, a local dev server, nothing else.
 *
 * Prod's URL sits in the same config file as dev's, so "point it at dev" is a
 * decision that can be got wrong silently. Overridable towards something on
 * this list and nowhere else — an environment variable that could reach prod
 * would make every guard below decorative.
 *
 * Adding localhost does not widen that. A local page is served from this
 * machine and the check still refuses every deployed site but dev's, so the
 * address that must never be driven is still unreachable from here.
 */
const ALLOWED_SITES = [DEV_SITE, ...LOCAL_SITES] as const;

const isLocal = (site: string): boolean => (LOCAL_SITES as readonly string[]).includes(site);

const baseURL = process.env["E2E_BASE_URL"] ?? DEV_SITE;
if (!ALLOWED_SITES.includes(baseURL as (typeof ALLOWED_SITES)[number])) {
  throw new Error(
    `E2E_BASE_URL must be one of ${ALLOWED_SITES.join(", ")} — refusing to drive a browser at ${baseURL}`,
  );
}

/** The site under test, for anything that needs to name it rather than fetch it. */
export const BASE_URL = baseURL;

/** Where `packages/web` keeps the values its dev server falls back to. */
const WEB_ENV_FILE = fileURLToPath(new URL("../packages/web/.env.local", import.meta.url));

/**
 * The `VITE_*` variables as the Vite dev server itself would resolve them.
 *
 * Vite reads `.env.local` and then lets anything inline in the process
 * environment win (`vite/src/node/env.ts`), so a value exported in the shell
 * overrides the file for the browser and has to override it here too —
 * otherwise this suite would confine the browser to one backend while the page
 * it is driving talks to another, and every request would be aborted for
 * reasons nothing on screen could explain.
 *
 * Read rather than required to be exported, because the file is how somebody
 * running `npm run dev -w @tightarse/web` already has these set. Needing them a
 * second time in the shell is the kind of difference that presents as a broken
 * dashboard.
 */
function viteEnv(): Record<string, string | undefined> {
  const fromFile: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(WEB_ENV_FILE, "utf8");
  } catch {
    text = "";
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?(VITE_[A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
    // An unquoted value runs to a `#` comment; a quoted one is taken whole.
    fromFile[match[1]!] = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "");
  }
  const fromProcess: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITE_")) fromProcess[key] = value;
  }
  return { ...fromFile, ...fromProcess };
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
 *
 * A Vite dev server serves no `/config.json`, and the application knows that:
 * it falls back to `VITE_*` (`web/src/config.ts:48`). So does this, from the
 * same variables in the same precedence — the allow-list is still whatever the
 * page under test will actually use, which is the property that matters, rather
 * than a list written out by hand.
 */
async function allowedOrigins(site: string): Promise<string[]> {
  if (isLocal(site)) {
    const env = viteEnv();
    const apiUrl = env["VITE_API_URL"];
    const hostedUiDomain = env["VITE_HOSTED_UI_DOMAIN"];
    if (!apiUrl || !hostedUiDomain) {
      throw new Error(
        `${site} serves no config.json, so VITE_API_URL and VITE_HOSTED_UI_DOMAIN say where the ` +
          `browser may go. Set them in ${WEB_ENV_FILE} or export them — the same two the dev ` +
          `server itself reads`,
      );
    }
    return [site, new URL(apiUrl).origin, `https://${hostedUiDomain}`];
  }

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
  //
  // A local base URL does not relax this. Only the page is local; the five
  // reads still land on dev's API and count against the same limit.
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
  /**
   * Longer than Playwright's five seconds, because this suite waits on a cold
   * Lambda rather than on a local render.
   *
   * Measured on 7 October 2026: dev's read API returned in 7.1 to 7.8 seconds
   * with no errors and no timeouts, and six of nineteen scenarios failed
   * asserting against a page that was still loading. Thirteen passed and two
   * passed on retry — the signature of a timeout, not of a broken deployment.
   *
   * Fifteen seconds matches the API Lambda's own timeout. Past that the
   * function has given up, so a failure here is the deployment failing rather
   * than this suite being impatient — which is the only thing a canary should
   * ever report.
   *
   * It is not a licence for a slow dashboard. Seven seconds for a read is
   * worth its own look; this stops the canary reporting it as a broken page.
   */
  expect: { timeout: 15_000 },
  /**
   * The whole scenario, not one assertion. Playwright's default is thirty
   * seconds and a merchant search against dev exceeded it: the ledger there
   * grew to sixteen thousand transactions when a mock bank was connected on
   * 4 October, and the scenarios predate that.
   *
   * Sixty rather than higher. A canary that waits two minutes to report is one
   * nobody waits for, and the point of the stage is to gate a deploy.
   */
  timeout: 60_000,
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
