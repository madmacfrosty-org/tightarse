import { test, expect } from "./fixtures.js";

/**
 * The behaviour described in `specs/operations.spec.md`, executed.
 *
 * Scenario 2 is the one that must never be completed. Roughly an hour after a
 * bank authorisation only ninety days of history remain available, for ever —
 * so a test that finishes that flow destroys years of a real household's data
 * and no retry recovers it. It is skipped entirely rather than asserted up to
 * the departure, because the departure is a redirect off the allow-list and
 * getting that wrong in a test is not worth the risk.
 */

test("the page carries the operator's work and not the household's", async ({ page }) => {
  await page.goto("/operations");

  await expect(page.getByRole("heading", { name: "Connect a bank" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /running balance/i }),
  ).toBeVisible();
});

test("nothing here is on the household's way", async ({ page }) => {
  await page.goto("/");

  // The glance is unaffected by work nobody does weekly. This is how the
  // original single page grew a running-balance diagnostic between the books
  // and the transaction list.
  await expect(page.getByRole("heading", { name: "Connect a bank" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /running balance/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Net position" })).toBeVisible();
});

test("the ledger can be checked against the bank", async ({ page }) => {
  await page.goto("/operations");

  const check = page.waitForResponse(
    (r) => r.url().includes("/diagnostics/running-balance") && r.status() === 200,
  );
  await page.getByRole("button", { name: /run|check/i }).first().click();
  const report = (await (await check).json()) as {
    verdict: string;
    accounts: { verdict: string }[];
  };

  // A verdict per account, and where they disagree, the rows that displace the
  // balance. "It does not match" without naming rows is a worry rather than a
  // finding, and this check exists because it found real ones.
  expect(report.accounts.length).toBeGreaterThan(0);
  await expect(page.getByText(new RegExp(report.verdict, "i")).first()).toBeVisible();
});

test.skip("every connection says how long it has left", () => {
  // specs/operations.spec.md scenario 1 — proposed. The page shows the connect
  // flow and the reconciliation check; a list of connections with their expiry
  // is not built. The urgent case is served on `/`, which is a different job.
});

test.skip("starting a connection leaves for the provider", () => {
  // specs/operations.spec.md scenario 2. Never run. An hour after an
  // authorisation only ninety days of history remain, for ever.
});
