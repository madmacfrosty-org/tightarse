import { z } from "zod";
import type { Candidate, Classification } from "@tightarse/domain";
import { CATEGORIES, FALLBACK_CATEGORY, isCategory, type Category } from "@tightarse/domain";

/**
 * Prompt construction and response parsing. Pure — no Bedrock, no network — so
 * the fiddly part is testable without spending tokens.
 */

/** What the model is asked to return, one entry per candidate. */
export const ModelOutput = z.object({
  results: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      category: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export const SYSTEM_PROMPT = `You categorise UK bank transactions for a household finance app.

For each transaction you are given a bank description, a signed amount in major units (negative is money out), and the bank's own coarse type where available.

Rules:
- Choose exactly one category from the allowed list for each transaction.
- Bank descriptions are terse, abbreviated and often contain reference numbers, store numbers or location codes. Use the recognisable merchant or organisation name and ignore the noise.
- The bank's coarse type describes the payment mechanism, not the purpose. A DIRECT_DEBIT can be Utilities, Insurance, Subscriptions or Council Tax. Use it as weak evidence only.
- A positive amount is money in. It is usually Income, but can be a refund, in which case categorise it as whatever was originally bought.
- Use "Other" when the description genuinely does not identify a purpose. A confident wrong category is worse than an honest "Other", because a misfiled transaction is much harder to notice than an uncategorised one.
- confidence is your own estimate from 0 to 1. Be honest: low confidence on a genuinely ambiguous description is useful signal.

Allowed categories:
${CATEGORIES.join(", ")}`;

export function buildPrompt(candidates: readonly Candidate[]): string {
  const lines = candidates.map((c, i) => {
    const amount = (c.amount / 100).toFixed(2);
    const type = c.providerCategory ? `  type=${c.providerCategory}` : "";
    return `${i}. "${c.description}"  amount=${amount} ${c.currency}${type}`;
  });
  return `Categorise these ${candidates.length} transactions:\n\n${lines.join("\n")}`;
}

/**
 * Turn a model response into classifications.
 *
 * Deliberately forgiving about what the model returns and strict about what
 * gets stored: an unknown category becomes "Other" at zero confidence rather
 * than being written as-is, because a category outside the taxonomy would
 * silently fragment every aggregation that uses it.
 *
 * Missing entries are returned as unclassified rather than guessed, so a
 * truncated response leaves work in the backlog instead of filling the ledger
 * with fabrications.
 */
export function parseResponse(
  candidates: readonly Candidate[],
  raw: unknown,
): { classifications: Classification[]; rejected: number; missing: number } {
  const parsed = ModelOutput.safeParse(raw);
  if (!parsed.success) {
    return { classifications: [], rejected: 0, missing: candidates.length };
  }

  const byIndex = new Map<number, { category: string; confidence: number }>();
  for (const r of parsed.data.results) byIndex.set(r.i, r);

  const classifications: Classification[] = [];
  let rejected = 0;
  let missing = 0;

  candidates.forEach((c, i) => {
    const r = byIndex.get(i);
    if (!r) {
      missing += 1;
      return;
    }
    if (!isCategory(r.category)) {
      rejected += 1;
      classifications.push({ dedupKey: c.dedupKey, category: FALLBACK_CATEGORY, confidence: 0 });
      return;
    }
    classifications.push({
      dedupKey: c.dedupKey,
      category: r.category,
      confidence: r.confidence,
    });
  });

  return { classifications, rejected, missing };
}
