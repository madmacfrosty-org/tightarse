import { test as setup, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { confineToAllowedOrigins, SESSION_FILE } from "../tests/fixtures.js";

/**
 * Sign in once, and save the session for every other project.
 *
 * A password rather than Google. The pool supports both — "password sign-in
 * stays enabled alongside Google" (`data-stack.ts:316`) — and driving a real
 * Google login would mean either a real Google account or a bot-detection
 * fight, neither of which belongs in a test.
 *
 * The credentials come from the environment and the state is written somewhere
 * `.gitignore` covers. Neither is in the tree: the state file is a live session,
 * and this repository is public.
 */
const STATE = "./.auth/user.json";

setup("sign in as the dev test identity", async ({ page }) => {
  await confineToAllowedOrigins(page);

  const email = process.env["E2E_EMAIL"];
  const password = process.env["E2E_PASSWORD"];
  // Fail with the reason rather than with a timeout on a form that never
  // appeared. A missing variable is a setup mistake, not a broken dashboard.
  if (!email || !password) {
    throw new Error(
      "E2E_EMAIL and E2E_PASSWORD must be set — the dev-only test identity, never the household's own account",
    );
  }

  await page.goto("/");
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

  // Back on the dashboard, signed in. Asserted before saving, so a broken
  // sign-in produces an empty state file nothing can explain.
  await expect(page).toHaveURL(new RegExp("^" + (process.env["E2E_BASE_URL"] ?? "https://d235jlz4kj7lqs.cloudfront.net")));
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible({ timeout: 30_000 });

  await page.context().storageState({ path: STATE });

  // And sessionStorage separately, because `storageState` does not include it
  // and this application keeps its tokens there on purpose (`auth.ts:16`).
  // Without this every test starts signed out, which looks like a broken
  // dashboard rather than a harness that cannot carry a session.
  await mkdir(".auth", { recursive: true });
  await writeFile(
    SESSION_FILE,
    await page.evaluate(() => JSON.stringify(Object.assign({}, sessionStorage))),
  );
});
