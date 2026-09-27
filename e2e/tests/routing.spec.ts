import { test, expect, blocked } from "./fixtures.js";

/**
 * The behaviour described in `specs/routing.spec.md`, executed.
 *
 * These are the tests that would have caught the split going wrong. A page
 * serving the wrong content, a nav that cannot reach somewhere, or a mistyped
 * address rendering the glance as though it had been right — none of those is
 * visible to a component test, because each is a fact about the routes rather
 * than about a component.
 */

const PAGES = [
  { path: "/", heading: "Net position" },
  { path: "/spending", heading: "Money in and out" },
  { path: "/categories", heading: "Categorise a merchant" },
  { path: "/operations", heading: "Connect a bank" },
] as const;

test("signing in lands on the glance", async ({ page }) => {
  // The session is already established by the setup project, so this asserts
  // where a signed-in visit to the root arrives rather than re-running sign-in.
  await page.goto("/");

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Net position" })).toBeVisible();
});

for (const { path, heading } of PAGES) {
  test(`${path} shows its own work and nothing else`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

    // The negative half, which is the point. Each page was one section of a
    // single scrolling page, and the failure this guards is a section
    // reappearing somewhere it does not belong — which is how the original
    // page grew until a glance and a twenty-minute sitting shared a surface.
    for (const other of PAGES) {
      if (other.path === path) continue;
      await expect(
        page.getByRole("heading", { name: other.heading }),
      ).toHaveCount(0);
    }
  });
}

test("every page can reach every other", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Pages" });

  for (const label of ["Spending", "Categories", "Home"]) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(
      page.getByRole("link", { name: label, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }

  // Reachable without typing an address, and deliberately not given the same
  // prominence as the three used weekly.
  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect a bank" })).toBeVisible();
});

test("an unknown path says so rather than rendering the glance", async ({ page }) => {
  await page.goto("/not-a-page");

  await expect(
    page.getByRole("heading", { name: /does not exist/i }),
  ).toBeVisible();
  // The failure worth guarding: a figure under the wrong heading is worse than
  // no figure, and CloudFront serves index.html for 404 so a mistyped path
  // arrives at the application rather than at an error page.
  await expect(page.getByRole("heading", { name: "Net position" })).toHaveCount(0);
  await page.getByRole("link", { name: /back to where we stand/i }).click();
  await expect(page.getByRole("heading", { name: "Net position" })).toBeVisible();
});

test("the browser never left the environment under test", async ({ page }) => {
  for (const { path } of PAGES) await page.goto(path);
  expect(blocked, `blocked off-origin requests: ${blocked.join(", ")}`).toEqual([]);
});

test.skip("a page can be linked to, and comes back the same", () => {
  // specs/routing.spec.md scenario 4 — proposed. The range is not in the
  // address yet, so `/spending` looks identical whatever period is shown and
  // a review cannot be returned to.
});

test.skip("a deep link while signed out arrives signed in", () => {
  // specs/routing.spec.md scenario 7 — proposed. Cognito's redirect target is
  // the site root, so the requested path does not survive the round trip
  // through the identity provider. Nothing carries it today.
});
