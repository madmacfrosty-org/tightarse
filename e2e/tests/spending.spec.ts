import { test, expect } from "./fixtures.js";

/**
 * The behaviour described in `specs/spending.spec.md`, executed.
 *
 * Three of these are about money being counted wrongly rather than about the
 * page working, and each guards a mistake that has already been made once:
 * transfers counted as both income and spending, money that moved counted as
 * money gone, and a provider's own label presented as a household category.
 */

test("income and spending describe the chosen range", async ({ page }) => {
  const summary = page.waitForResponse(
    (r) => r.url().includes("/summary") && r.status() === 200,
  );
  await page.goto("/spending");
  const first = (await (await summary).json()) as { transactionCount: number };

  await expect(page.getByRole("heading", { name: "Money in and out" })).toBeVisible();

  const narrowed = page.waitForResponse(
    (r) => r.url().includes("/summary") && r.status() === 200,
  );
  await page.getByRole("group", { name: "Time range" })
    .getByRole("button", { name: "3 months" }).click();
  const second = (await (await narrowed).json()) as { transactionCount: number };

  // A shorter window cannot contain more. Asserting the direction rather than a
  // figure keeps this true against a ledger that grows.
  expect(second.transactionCount).toBeLessThanOrEqual(first.transactionCount);
});

test("transfers between our own accounts are netted, and said so", async ({ page }) => {
  const summary = page.waitForResponse(
    (r) => r.url().includes("/summary") && r.status() === 200,
  );
  await page.goto("/spending");
  const s = (await (await summary).json()) as {
    transferCount: number;
    internalTransfersNetted: boolean;
  };

  expect(s.internalTransfersNetted).toBe(true);
  if (s.transferCount > 0) {
    // Stated rather than silently removed. A figure that quietly shrinks is
    // indistinguishable from one that was right, and before netting existed
    // this inflated five-year totals by more than half on both sides.
    await expect(page.getByText(/moved/i).first()).toBeVisible();
  }
});

test("money that moved rather than went is excluded and counted", async ({ page }) => {
  const summary = page.waitForResponse(
    (r) => r.url().includes("/summary") && r.status() === 200,
  );
  await page.goto("/spending");
  const s = (await (await summary).json()) as { balanceSheetCount: number };

  if (s.balanceSheetCount > 0) {
    // Paying a card and moving to savings both leave an account. Counting them
    // as spending is the same error as counting a transfer, reached from the
    // category side — #109.
    await expect(page.getByText(/rather than were spent/i)).toBeVisible();
  }
});

test("categories are ordered by what they cost", async ({ page }) => {
  const summary = page.waitForResponse(
    (r) => r.url().includes("/summary") && r.status() === 200,
  );
  await page.goto("/spending");
  const s = (await (await summary).json()) as {
    byCategory: { total: number }[];
  };

  await expect(page.getByRole("heading", { name: "Where it goes" })).toBeVisible();

  // Largest spending first. Totals are negative for spending, so ascending.
  const totals = s.byCategory.map((c) => c.total);
  expect(totals).toEqual([...totals].sort((a, b) => a - b));
});

test.skip("what changed since the period before", () => {
  // specs/spending.spec.md scenario 5 — proposed, and the largest gap against
  // the aim. Nothing compares one period against another, so a category that
  // doubled looks like any other bar.
});

test.skip("what is being paid for on repeat", () => {
  // specs/spending.spec.md scenario 6 — proposed. `detectRecurring` already
  // finds what repeats and feeds rule-writing; it is not shown to the person
  // who would act on it.
});
