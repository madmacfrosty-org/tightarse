import { test as setup, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { confineToAllowedOrigins, ON_SITE, SESSION_FILE, signIn } from "../tests/fixtures.js";

/**
 * Sign in once, and save the session for every other project.
 *
 * The sign-in itself lives in `fixtures.ts`, because `routing.spec.ts` has
 * scenarios about signing in and has to do it too.
 *
 * The credentials come from the environment and the state is written somewhere
 * `.gitignore` covers. Neither is in the tree: the state file is a live session,
 * and this repository is public.
 */
const STATE = "./.auth/user.json";

setup("sign in as the dev test identity", async ({ page }) => {
  await confineToAllowedOrigins(page);

  await page.goto("/");
  await signIn(page);

  // Back on the dashboard, signed in. Asserted before saving, so a broken
  // sign-in produces an empty state file nothing can explain.
  //
  // The origin, not the path. *Which* page a sign-in finishes on is scenario 1
  // of `routing.spec.md`, and asserting it here as well would turn that
  // scenario's failure into a setup failure that stops every other test with a
  // message about the wrong thing.
  await expect(page).toHaveURL(ON_SITE);

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
