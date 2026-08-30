/**
 * Turning stored rows into domain values at the boundary.
 *
 * The adapter used to hand back `Record<string, unknown>` and let each consumer
 * assert a shape onto it. That is the defect in #41: a field renamed on the
 * write side leaves every build and every test green, and the read side goes on
 * confidently returning answers about a property that is now always undefined.
 * Parsing here is what makes a rename fail somewhere.
 *
 * Two policies, because rows are not all the same kind of thing.
 */

import type { z } from "zod";

/**
 * Parse rows that are facts, failing loudly if any will not.
 *
 * A transaction is money that moved. Dropping one because it did not parse does
 * not degrade the answer, it changes it — the totals silently come out short,
 * and nothing in the product distinguishes "you spent less" from "we could not
 * read a row". The household's totals are the product, so an unreadable fact is
 * an outage, not a rounding error.
 *
 * Every stored row parsed when this was written, so throwing is not a routine
 * path. That is the point: if it ever throws, something genuinely changed
 * shape.
 */
export function parseFacts<S extends z.ZodTypeAny>(
  schema: S,
  rows: readonly unknown[],
  what: string,
): z.infer<S>[] {
  return rows.map((row, i) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      // The row itself is not in the message. This repository is public and the
      // rows are a household's real transactions; the path and the reason are
      // enough to find the problem, and the value never is.
      const why = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`unreadable ${what} row at index ${i}: ${why}`);
    }
    return parsed.data;
  });
}
