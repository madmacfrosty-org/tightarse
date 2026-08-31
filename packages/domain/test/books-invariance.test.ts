/**
 * The figures the books migration must not move.
 *
 * #108 rewrites the ledger's model in terms of books, legs and trades, and its
 * first step is explicitly "name the concepts, change nothing". The claim that
 * nothing changed is only worth something if the figures were written down
 * before the rewrite started. These are those figures, captured from the code as
 * it stood at the head of `main` before a single type was renamed.
 *
 * **This is a change detector, not a correctness check**, and
 * [the test strategy](../../../docs/conventions/test-strategy.md) is right that a
 * snapshot of a calculation records whatever the code produced, bug included.
 * That is precisely what is wanted here and nowhere else: the question is not
 * whether these numbers are right, it is whether they are the same. The tests
 * around them go on asking whether they are right.
 *
 * So it is scaffolding with a shelf life. When #108 is finished this file has
 * done its job and should go, rather than harden into a reason not to improve
 * the calculation.
 *
 * The ledger behind it is generated from a fixed seed and entirely invented —
 * see `ledger-sample.ts`.
 */

import { describe, it, expect } from "vitest";
import { sampleLedger } from "./ledger-sample.js";
import { summarise } from "../src/reporting/summary.js";
import { netPositionSeries, daysBetween } from "../src/reporting/balances.js";

const RANGE = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };

describe("books migration invariance", () => {
  it("summarises the sample ledger exactly as it did before the rewrite", () => {
    const s = sampleLedger();

    expect(summarise(s.transactions, s.categorisations, RANGE)).toEqual({
      "currency": "GBP",
      "from": "2026-01-01T00:00:00Z",
      "to": "2026-04-01T00:00:00Z",
      "transactionCount": 92,
      "income": 2039909,
      "spend": -748980,
      "net": 1290929,
      "byCategory": [
        {
          "category": "utilities",
          "total": -307572,
          "count": 33,
          "provisional": false
        },
        {
          "category": "groceries",
          "total": -232964,
          "count": 22,
          "provisional": false
        },
        {
          "category": "transport",
          "total": -173153,
          "count": 21,
          "provisional": false
        },
        {
          "category": "PURCHASE",
          "total": -35291,
          "count": 5,
          "provisional": true
        },
        {
          "category": "CREDIT",
          "total": 157312,
          "count": 1,
          "provisional": true
        },
        {
          "category": "salary",
          "total": 1882597,
          "count": 8,
          "provisional": false
        }
      ],
      "byMonth": [
        {
          "month": "2026-01",
          "income": 826298,
          "spend": -229836,
          "net": 596462,
          "count": 31
        },
        {
          "month": "2026-02",
          "income": 872733,
          "spend": -227495,
          "net": 645238,
          "count": 28
        },
        {
          "month": "2026-03",
          "income": 340878,
          "spend": -291649,
          "net": 49229,
          "count": 31
        }
      ],
      "internalTransfersNetted": true,
      "transferCount": 2,
      "transferTotal": 50000,
      "enrichedCount": 84
    });
  });

  it("puts the household in the same net position on every one of 90 days", () => {
    const s = sampleLedger();
    const days = daysBetween("2026-01-01", "2026-03-31");

    const nets = netPositionSeries(s.accounts, s.movements, days).map(
      (p) => p.net,
    );

    expect(nets).toEqual([
      -226173, 3158537, 3152348, 3140550, 3140550, 3140550,
      3135523, 3373637, 3356371, 3356371, 3356371, 3338427,
      3338427, 4576738, 4561319, 4560735, 4533885, 4517164,
      4517164, 4517164, 5105348, 5096580, 5081149, 5081149,
      5076113, 5076113, 5045728, 5042256, 5034053, 5030521,
      5030521, 5030521, 5005093, 4998227, 4998227, 4998227,
      4994676, 4994676, 5150478, 5142866, 5130090, 5126889,
      5109459, 5380968, 5380968, 5380968, 5367378, 5352003,
      5345402, 5307344, 5307344, 5307344, 5307344, 5277588,
      5277588, 5254636, 5254636, 5245656, 5675759, 5664676,
      5664676, 5647849, 5647849, 5636171, 5627121, 5627121,
      5627121, 5627121, 5627121, 5627121, 5589181, 5560816,
      5560816, 5546688, 5546688, 5530398, 5530398, 5527686,
      5501721, 5501721, 5501721, 5501721, 5453629, 5447838,
      5777276, 5761676, 5755263, 5755263, 5726819, 5724988,
    ]);
  });
});
