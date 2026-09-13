import { readFile } from "node:fs/promises";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGINS } from "../playwright.config.js";

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
