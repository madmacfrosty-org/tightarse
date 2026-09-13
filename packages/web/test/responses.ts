/**
 * Contract-shaped API responses, for tests.
 *
 * The fixtures used to be written inline, and #41 showed what that cost: the
 * ports parse now, and seventy tests failed at once because the shapes they had
 * always returned were not the shapes the API sends. `/transactions` carries the
 * range it answered for; `/connect/start` carries the state that survives the
 * round trip through the provider. Neither was in a single fixture.
 *
 * So the shapes live here, once, where a missing field is one fix rather than
 * twenty. A test that needs a malformed response still writes one inline — that
 * is a different test, and it should look different.
 */

/** Any range; the components ask for their own and this is only the echo. */
export const RANGE = { from: "2025-08-01", to: "2026-08-01" } as const;

/** `GET /transactions`. The range is required and was missing everywhere. */
export const transactionsResponse = (transactions: readonly unknown[] = []) => ({
  range: RANGE,
  transactions,
});

/** `GET /categories`. */
export const categoriesResponse = (categories: readonly unknown[] = []) => ({
  categories,
});
