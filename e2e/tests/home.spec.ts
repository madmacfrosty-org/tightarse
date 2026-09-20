import { test, expect, blocked } from "./fixtures.js";

/**
 * The behaviour described in `specs/home.spec.md`, executed.
 *
 * The scenarios there name the job each one serves and say which are covered;
 * this file holds the covered ones. A scenario with no test here is intent
 * rather than a claim, and the markdown says so.
 *
 * The one thing stages 1 to 3 cannot see: whether the deployed API and the
 * deployed dashboard agree.
 *
 * `packages/web` has component tests, and #165 made them parse the contract, so
 * a shape mismatch now fails there. What no component test can reach is the
 * pair actually running — a wrong field name that both sides happen to share,
 * a build served from a stale bundle, a CORS rule, a token without the claim.
 * Every incident this project has had was wiring, and this is the first test
 * that looks at wiring.
 *
 * The assertion is deliberately about a *number*. That the page renders is
 * worth little; that the figure on it is the figure the API sent is the thing
 * a person would notice being wrong, and the thing nothing else checks.
 */

/** The dashboard's own formatter, `charts.tsx:20`. Reproduced, not imported —
 *  importing it would make the test agree with the app by construction. */
const money = (minor: number): string => {
  const s = (Math.abs(minor) / 100).toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
  });
  return minor < 0 ? `−${s}` : s;
};

test("the net position on screen is the one the API sent", async ({ page }) => {
  // Captured from the browser's own traffic rather than fetched separately: a
  // second request could be answered differently, and then the test would be
  // comparing the page against something the page never saw.
  const booksResponse = page.waitForResponse(
    (r) => r.url().includes("/books") && r.status() === 200,
  );

  await page.goto("/");

  const books = (await (await booksResponse).json()) as {
    householdPosition: number;
  };

  await expect(page.getByRole("heading", { name: "Net position" })).toBeVisible();
  await expect(page.getByText(money(books.householdPosition), { exact: true }))
    .toBeVisible();
});

test("the browser never left the environment under test", async ({ page }) => {
  // The guard asserting itself. If a redirect or an asset ever pointed off the
  // allow-list, this says which — otherwise the confinement is a claim nobody
  // checks, and a silently broken route would make every other test here weaker
  // than it looks.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Net position" })).toBeVisible();

  expect(blocked, `blocked off-origin requests: ${blocked.join(", ")}`).toEqual([]);
});
