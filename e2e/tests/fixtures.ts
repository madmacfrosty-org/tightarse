import { readFile } from "node:fs/promises";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGINS, BASE_URL } from "../playwright.config.js";

/** Where `auth.setup.ts` leaves the signed-in session. Gitignored. */
export const SESSION_FILE = "./.auth/session.json";

/**
 * A page that cannot leave the environment under test.
 *
 * The config declares which origins are allowed; this is what makes the
 * declaration true. Every request is checked, and anything off the list is
 * aborted rather than followed — so a redirect, a link, an injected script or a
 * mistyped base URL cannot walk the browser into prod or out to a third party.
 *
 * Aborting rather than failing the test outright is deliberate: a page that
 * loads a font from a CDN should not fail a dashboard assertion. What matters is
 * that the request does not happen. Anything aborted is recorded, so a test that
 * depended on it fails on its own assertion with the reason visible.
 */
export const blocked: string[] = [];

export async function confineToAllowedOrigins(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    const allowed =
      ALLOWED_ORIGINS.some((origin) => url.startsWith(origin)) ||
      url.startsWith("data:") ||
      url.startsWith("blob:") ||
      url === "about:blank";
    if (allowed) return route.continue();
    blocked.push(url);
    return route.abort();
  });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Anywhere on the site under test.
 *
 * Built rather than written out, because the base URL is now one of three and a
 * test that hard-coded dev's would pass against a local server for the wrong
 * reason. The escape matters for the same reason: `127.0.0.1` used as a regular
 * expression matches `127a0b0c1`, so an unescaped assertion about where the
 * browser finished is not an assertion at all.
 */
export const ON_SITE = new RegExp(`^${escapeRegExp(BASE_URL)}`);

/**
 * A pattern matching one path on the site under test, and nothing else.
 *
 * A query string or a fragment is allowed to follow, because an address that
 * carries what is on screen is a thing the routing spec asks for; another path
 * segment is not.
 */
export function urlOf(path: string): RegExp {
  return new RegExp(`^${escapeRegExp(BASE_URL + path)}(?:[?#]|$)`);
}

/**
 * The dashboard's own formatter, `charts.tsx:20`. Reproduced, not imported —
 * importing it would make the test agree with the app by construction, and a
 * formatter both sides share cannot disagree about the number underneath it.
 *
 * Note the minus: U+2212, not a hyphen. A test typing the wrong one fails with
 * two strings that look identical in the report.
 */
export const money = (minor: number, opts: { sign?: boolean } = {}): string => {
  const s = (Math.abs(minor) / 100).toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
  });
  if (minor < 0) return `−${s}`;
  return opts.sign ? `+${s}` : s;
};

/**
 * Sign in through Cognito's hosted UI, on whatever page is given.
 *
 * Shared between `auth.setup.ts`, which does it once for the whole run, and the
 * routing scenarios that are *about* signing in and therefore have to start
 * signed out. One copy, because two would drift and the second one to drift
 * would look like a broken sign-in rather than a stale test.
 *
 * A password rather than Google. The pool supports both — "password sign-in
 * stays enabled alongside Google" (`data-stack.ts:316`) — and driving a real
 * Google login would mean either a real Google account or a bot-detection
 * fight, neither of which belongs in a test.
 */
export async function signIn(page: Page): Promise<void> {
  const email = process.env["E2E_EMAIL"];
  const password = process.env["E2E_PASSWORD"];
  // Fail with the reason rather than with a timeout on a form that never
  // appeared. A missing variable is a setup mistake, not a broken dashboard.
  if (!email || !password) {
    throw new Error(
      "E2E_EMAIL and E2E_PASSWORD must be set — the dev-only test identity, never the household's own account",
    );
  }

  await page.getByRole("button", { name: /sign in/i }).click();

  // Cognito's hosted UI. A second origin, which is why it is on the allow-list.
  //
  // Scoped to the visible form, because the hosted UI renders the whole thing
  // TWICE — a modal layout and a cover layout, one of them hidden — so every
  // field and the submit button each resolve to two elements. Playwright's
  // strict mode is right to refuse that rather than pick one.
  //
  // `:visible` rather than `.first()`: the first in DOM order is not reliably
  // the shown one, and clicking the hidden copy would wait for actionability
  // until it timed out, which reads as "the form never appeared".
  const form = page.locator("form:visible").first();
  await form.locator('input[name="username"]:visible').fill(email);
  await form.locator('input[name="password"]:visible').fill(password);
  await form.locator('input[name="signInSubmitButton"]:visible').click();

  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible({ timeout: 30_000 });
}

/**
 * Put the signed-in session back, because Playwright cannot carry it.
 *
 * `storageState` saves cookies and localStorage. This application deliberately
 * keeps its tokens in **sessionStorage** — "so a session does not survive
 * closing the browser" (`auth.ts:16`) — which `storageState` does not capture.
 * Reusing sign-in the usual way therefore produced a context that was signed
 * out, and every test landed on the sign-in page.
 *
 * So the setup writes sessionStorage out, and this puts it back before any page
 * script runs. The application's own choice is preserved rather than worked
 * around: nothing here makes the token outlive the browser.
 */
async function restoreSession(context: BrowserContext): Promise<void> {
  const raw = await readFile(SESSION_FILE, "utf8").catch(() => null);
  if (raw === null) return;
  await context.addInitScript((data: string) => {
    for (const [key, value] of Object.entries(JSON.parse(data) as Record<string, string>)) {
      sessionStorage.setItem(key, value);
    }
  }, raw);
}

export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({ context }, use) => {
    await restoreSession(context);
    await use(context);
  },
  page: async ({ page }, use) => {
    // Cleared per test: the array is module scope, so one test's aborted
    // request would otherwise fail an assertion in the next one and read as a
    // confinement breach that never happened.
    blocked.length = 0;
    await confineToAllowedOrigins(page);
    await use(page);
  },
});

export { expect };
