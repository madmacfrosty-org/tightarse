/**
 * Keep measurements of the household's ledger out of a public repository.
 *
 * This repository is public and the data behind it is one family's real
 * finances. The rule against putting a transaction, description or merchant in
 * a file has always been understood; a COUNT was not, because a count is none
 * of those things. That gap has been walked through three times — twice into a
 * public issue and a pull request that GitHub will not let anyone delete, and
 * once into a source comment.
 *
 * An aggregate is a statistical profile. A row count says how much a
 * household spends through; a five-year total says what it earns; a balance
 * quoted to the penny is that family's money on a given day. None of it is less
 * identifying for being summarised.
 *
 * The style this collides with is a good one — these comments explain a design
 * by citing the measurement that forced it, and that is why they are worth
 * reading. The convention is not "stop measuring". It is "keep the finding,
 * drop the figure": say what the measurement showed, not what it counted.
 * `docs/conventions/measurements.md` has the long version.
 *
 * False positives are expected: a DynamoDB write-capacity limit and a chart's
 * axis example are both numbers that look like this and neither is anyone's
 * money. Silence those individually, with a reason, so the exception is a
 * decision somebody made rather than a rule nobody runs:
 *
 *   // eslint-disable-next-line tightarse/no-household-figures -- provider quota, not our data
 */

/**
 * Money quoted precisely: £1,234.56, £4.20.
 *
 * Precision is the signal. A walkthrough in a test invents round numbers —
 * "owes £50 now, £20 of that was spent on the 3rd" — because round numbers are
 * what makes the arithmetic followable. A figure carried to the penny was
 * almost always read off the real ledger, because nobody invents 90p of change
 * to explain a design.
 *
 * `.00` is excluded: a rendering case for "£0.00" is a shape, not a sum.
 */
const PRECISE_MONEY = /[£$€]\s?\d[\d,]*\.(?!00\b)\d{1,2}/u;

/**
 * A grouped integer: 1,234 — the shape a counted ledger comes out as.
 *
 * Catches large money for the same reason (£99,999), since a separator appears
 * at exactly the magnitude where invented examples stop being used.
 *
 * Four digits without a separator are not flagged. A year, a port and an issue
 * number all look like that, and flagging them would train people to disable
 * the rule rather than read it.
 */
const GROUPED = /\b\d{1,3},\d{3}\b/u;

/** Abbreviated money: £99k, £1.2m. A total, and always a real one. */
const ABBREVIATED = /[£$€]\s?\d+(?:\.\d+)?\s?[mk]\b/iu;

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow figures measured from the household's ledger in comments. This repository is public.",
    },
    schema: [],
    messages: {
      figure:
        "This comment carries a figure that looks measured from the household's ledger ({{match}}). " +
        "The repository is public. Keep the finding and drop the number — say what the measurement " +
        "showed, not what it counted. If this figure is not the household's data, disable the rule on " +
        "this line with a reason.",
    },
  },

  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();

    return {
      Program() {
        for (const comment of source.getAllComments()) {
          // Directives are machinery, not prose, and one of them is the
          // suppression for this very rule.
          if (/^\s*(eslint|prettier|@ts-|global|jsx)/u.test(comment.value))
            continue;

          for (const pattern of [PRECISE_MONEY, GROUPED, ABBREVIATED]) {
            const found = pattern.exec(comment.value);
            if (found) {
              context.report({
                loc: comment.loc,
                messageId: "figure",
                data: { match: found[0].trim() },
              });
              break;
            }
          }
        }
      },
    };
  },
};
