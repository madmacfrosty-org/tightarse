/**
 * What a ledger looks like before anyone writes a rule for it.
 *
 * Rules are proposed from patterns, and a pattern is only visible once the
 * corpus is collapsed. A ledger holds far fewer distinct descriptions than
 * transactions, and most of those descriptions are seen exactly once — so the
 * interesting structure is in the collapse, not in the transactions.
 *
 * Two collapses, because there are two ways a payment repeats. Most repeat under
 * a stable description. Some repeat under a stable *amount* while the description
 * carries a reference that changes every month, and no amount of stemming will
 * ever group those.
 *
 * Pure, and the corpus arrives as an argument. Holds descriptions, so the result
 * is for a terminal, an API response or a proposer in memory, and never for a
 * file.
 */

/**
 * One transaction, as the summariser is allowed to see it.
 *
 * Not a `Candidate`. That type is what a *matcher* sees, and it deliberately has
 * no timestamp: a rule may read what a transaction says about itself, and giving
 * it a clock would invite rules that match on time. Recurrence needs timestamps
 * but can never be a matcher — `matches(rule, candidate)` sees one candidate,
 * and a cadence is a property of the corpus — so the two types stay apart.
 */
export interface Sighting {
  readonly description: string;
  /** Signed minor units, normalised: negative left the household. */
  readonly amount: number;
  /** Booking date, ISO-8601. */
  readonly timestamp: string;
  /** The category the rules currently give it, if any. */
  readonly category?: string;
}

export interface CategoryCount {
  readonly category: string;
  readonly transactions: number;
}

/** One description, and everything a proposer needs to judge a rule against it. */
export interface DescriptionSummary {
  readonly description: string;
  readonly transactions: number;
  /** Money that left the household, positive minor units. Credits are excluded. */
  readonly outgoing: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Sightings the rules currently give no category. */
  readonly uncategorised: number;
  /**
   * What the rules currently make of it, commonest first.
   *
   * Usually one entry. More than one means a description that is categorised
   * inconsistently, which is worth seeing before proposing a rule that would
   * flatten it.
   */
  readonly categories: readonly CategoryCount[];
}

export type Cadence = "weekly" | "fortnightly" | "four-weekly" | "monthly" | "quarterly" | "annual";

/** A repeated amount arriving on a regular beat. */
export interface Recurrence {
  /** Signed, so a recurring credit stays distinguishable from a recurring debit. */
  readonly amount: number;
  readonly cadence: Cadence;
  readonly transactions: number;
  readonly outgoing: number;
  /**
   * Every description this amount arrived under.
   *
   * More than one is the case this collapse exists for, and on real data it is
   * the common case rather than the exception.
   */
  readonly descriptions: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly uncategorised: number;
}

export interface CorpusSummary {
  /** Costliest first, so the caller reads the money before the noise. */
  readonly descriptions: readonly DescriptionSummary[];
  readonly recurrences: readonly Recurrence[];
  readonly scanned: number;
}

/**
 * Beats worth recognising, in days.
 *
 * Monthly is two entries because calendar months are not a fixed length and the
 * median gap of a monthly payment lands either side of 30 depending on which
 * months it spanned.
 */
const CADENCES: ReadonlyArray<readonly [number, Cadence]> = [
  [7, "weekly"],
  [14, "fortnightly"],
  [28, "four-weekly"],
  [30, "monthly"],
  [31, "monthly"],
  [91, "quarterly"],
  [365, "annual"],
];

/**
 * How far off the beat a payment may drift and still count.
 *
 * Proportional, because a fortnightly payment two days late is careless and an
 * annual one two days late is punctual. The floor of two days covers weekends,
 * which move nearly every direct debit at some point.
 */
const tolerance = (period: number): number => Math.max(2, period * 0.12);

const DAY_MS = 86_400_000;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const median = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * Name the beat a series of dates keeps, if it keeps one.
 *
 * Median rather than mean: one missed month would drag a mean far enough to lose
 * an otherwise regular payment, and the whole point is to find the regular ones.
 */
export function detectCadence(timestamps: readonly string[]): Cadence | undefined {
  const sorted = [...timestamps].sort();
  const gaps = sorted
    .slice(1)
    .map((t, i) => daysBetween(sorted[i]!, t))
    // Same-day pairs say nothing about a beat, and two payments of one amount on
    // one day is a pair of transactions rather than evidence of a rhythm.
    .filter((g) => g > 0);
  // Two gaps is the fewest that can agree on a beat, so three sightings is the
  // real minimum — and same-day repeats do not count toward it.
  if (gaps.length < 2) return undefined;

  const m = median(gaps);

  // Closest beat, not the first one that fits. The windows overlap — 28 days
  // tolerates up to 31.4 and would otherwise claim every monthly payment before
  // monthly was tried. Ties fall to the shorter period, which is the order
  // CADENCES is written in.
  let best: { cadence: Cadence; distance: number } | undefined;
  for (const [period, cadence] of CADENCES) {
    const distance = Math.abs(m - period);
    if (distance > tolerance(period)) continue;
    if (best === undefined || distance < best.distance) best = { cadence, distance };
  }
  return best?.cadence;
}

interface Bucket {
  transactions: number;
  outgoing: number;
  firstSeen: string;
  lastSeen: string;
  uncategorised: number;
  categories: Map<string, number>;
}

const emptyBucket = (timestamp: string): Bucket => ({
  transactions: 0,
  outgoing: 0,
  firstSeen: timestamp,
  lastSeen: timestamp,
  uncategorised: 0,
  categories: new Map(),
});

function absorb(bucket: Bucket, sighting: Sighting): void {
  bucket.transactions += 1;
  if (sighting.amount < 0) bucket.outgoing += -sighting.amount;
  if (sighting.timestamp < bucket.firstSeen) bucket.firstSeen = sighting.timestamp;
  if (sighting.timestamp > bucket.lastSeen) bucket.lastSeen = sighting.timestamp;
  if (sighting.category === undefined) bucket.uncategorised += 1;
  else bucket.categories.set(sighting.category, (bucket.categories.get(sighting.category) ?? 0) + 1);
}

const tally = (categories: Map<string, number>): CategoryCount[] =>
  [...categories.entries()]
    .map(([category, transactions]) => ({ category, transactions }))
    .sort((a, b) => b.transactions - a.transactions || a.category.localeCompare(b.category));

/**
 * Collapse a corpus along both axes at once.
 *
 * One pass to bucket, then a cadence test per distinct amount. The alternative —
 * sampling — hides exactly what this is for, since a payment that repeats
 * quietly is the one nobody thought to sample.
 */
export function summariseCorpus(sightings: readonly Sighting[]): CorpusSummary {
  const byDescription = new Map<string, Bucket>();
  const byAmount = new Map<number, { bucket: Bucket; timestamps: string[]; descriptions: Set<string> }>();

  for (const sighting of sightings) {
    const description = byDescription.get(sighting.description) ?? emptyBucket(sighting.timestamp);
    absorb(description, sighting);
    byDescription.set(sighting.description, description);

    const amount = byAmount.get(sighting.amount) ?? {
      bucket: emptyBucket(sighting.timestamp),
      timestamps: [],
      descriptions: new Set<string>(),
    };
    absorb(amount.bucket, sighting);
    amount.timestamps.push(sighting.timestamp);
    amount.descriptions.add(sighting.description);
    byAmount.set(sighting.amount, amount);
  }

  const recurrences: Recurrence[] = [];
  for (const [amount, { bucket, timestamps, descriptions }] of byAmount) {
    const cadence = detectCadence(timestamps);
    if (cadence === undefined) continue;
    recurrences.push({
      amount,
      cadence,
      transactions: bucket.transactions,
      outgoing: bucket.outgoing,
      descriptions: [...descriptions].sort(),
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      uncategorised: bucket.uncategorised,
    });
  }

  return {
    descriptions: [...byDescription.entries()]
      .map(([description, b]) => ({
        description,
        transactions: b.transactions,
        outgoing: b.outgoing,
        firstSeen: b.firstSeen,
        lastSeen: b.lastSeen,
        uncategorised: b.uncategorised,
        categories: tally(b.categories),
      }))
      .sort((a, b) => b.outgoing - a.outgoing || a.description.localeCompare(b.description)),
    recurrences: recurrences.sort((a, b) => b.outgoing - a.outgoing || a.amount - b.amount),
    scanned: sightings.length,
  };
}
