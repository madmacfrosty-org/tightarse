/**
 * Where a domain answer becomes an HTTP response.
 *
 * `@tightarse/domain` says what the application offers; `@tightarse/api-contract`
 * says what installed clients were promised. Those change for different reasons —
 * a browser reloads, an iOS build on somebody's phone does not — so they are two
 * statements, and this is the one place they meet.
 *
 * They are near-identities, and each is annotated on both sides, so if the domain
 * result and the wire promise ever stop agreeing this file fails to compile and
 * someone decides what the API should do about it. Previously the use cases had no
 * declared return type at all, so whatever the aggregation happened to produce was
 * served, and the contract was a document the code was merely expected to match.
 *
 * The copies are not ceremony. The domain returns `readonly` arrays — a result is
 * not the caller's to mutate — while the contract's types are inferred from Zod
 * and are mutable, so the conversion is real and the compiler already insisted on
 * it. Copying also means nothing downstream can reach back into the aggregation's
 * own arrays.
 *
 * When they diverge further — the first field the domain needs that clients must
 * not see, or the first rename the contract cannot afford — it happens here and
 * nothing else moves.
 */

import type {
  AccountsResponse,
  BacklogResponse,
  EffectView,
  PredictionView,
  ProposalResponse,
  BalancesResponse,
  SummaryResponse,
  TransactionsResponse,
} from "@tightarse/api-contract";
import type {
  AccountsResult,
  Backlog,
  BalancesResult,
  CategoriseReport,
  Preview,
  Proposed,
  Summary,
  TransactionsResult,
} from "@tightarse/domain";

export const asSummary = (s: Summary): SummaryResponse => ({
  ...s,
  byCategory: [...s.byCategory],
  byMonth: [...s.byMonth],
});

export const asTransactions = (t: TransactionsResult): TransactionsResponse => ({
  range: t.range,
  transactions: [...t.transactions],
});

export const asAccounts = (a: AccountsResult): AccountsResponse => ({
  ...a,
  accounts: [...a.accounts],
});

export const asBalances = (b: BalancesResult): BalancesResponse => ({
  range: b.range,
  points: [...b.points],
});

/**
 * The backlog, as the wire spells it.
 *
 * A pass-through in shape but not in kind: the domain's `Backlog` is free to
 * change with the application's needs, and this is a promise to whatever is
 * already calling. The range is echoed back so a caller can tell what was
 * actually served from what it asked for.
 */
export function asBacklog(range: { from: string; to: string }, backlog: Backlog): BacklogResponse {
  return {
    range,
    descriptions: backlog.descriptions.map((d) => ({
      description: d.description,
      transactions: d.transactions,
      outgoing: d.outgoing,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      uncategorised: d.uncategorised,
      categories: d.categories.map((c) => ({ category: c.category, transactions: c.transactions })),
    })),
    recurrences: backlog.recurrences.map((r) => ({
      amount: r.amount,
      cadence: r.cadence,
      transactions: r.transactions,
      outgoing: r.outgoing,
      descriptions: [...r.descriptions],
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      uncategorised: r.uncategorised,
    })),
    gaps: backlog.gaps.map((g) => ({
      description: g.description,
      transactions: g.transactions,
      outgoing: g.outgoing,
    })),
    conflicts: backlog.conflicts.map((c) => ({
      setId: c.setId,
      categories: [...c.categories],
      rules: [...c.rules],
      transactions: c.transactions,
      example: c.example,
    })),
    scanned: backlog.scanned,
  };
}

/**
 * How many affected transactions a response will carry per group.
 *
 * `recategorised` and `lost` are the groups where the identity of a transaction
 * changes the decision, and they stay small because a proposal taking thousands
 * of categorisations is refused on the count alone. `gained` is the one that
 * gets large, and nobody audits three thousand rows to check a pattern looks
 * right — a sample and a count answer that.
 *
 * Truncation is declared rather than silent. A caller shown 500 of 3,200 and
 * told so can ask for more; one shown 500 and told nothing draws a conclusion
 * from a fraction.
 */
const ENTRY_LIMIT: Record<keyof Omit<PredictionView, "introducedConflicts" | "scanned">, number> = {
  gained: 500,
  lost: 1000,
  recategorised: 1000,
  unchanged: 100,
  outranked: 100,
};

const asEffect = (effect: Preview["gained"], limit: number): EffectView => ({
  transactions: effect.transactions,
  outgoing: effect.outgoing,
  merchants: effect.merchants,
  entries: effect.entries.slice(0, limit).map((e) => ({
    dedupKey: e.dedupKey,
    description: e.description,
    ...(e.from === undefined ? {} : { from: e.from }),
    ...(e.to === undefined ? {} : { to: e.to }),
  })),
  truncated: effect.entries.length > limit,
});

/**
 * The prediction, as the wire spells it.
 *
 * Computed by the server and never supplied by the caller — a proposal carrying
 * its own account of its effect would defeat the arrangement where a model may
 * write rules and only deterministic code says what they do.
 */
export function asProposalResponse(
  prediction: Preview,
  proposed?: readonly Proposed[],
  applied?: CategoriseReport,
): ProposalResponse {
  return {
    prediction: {
      gained: asEffect(prediction.gained, ENTRY_LIMIT.gained),
      lost: asEffect(prediction.lost, ENTRY_LIMIT.lost),
      recategorised: asEffect(prediction.recategorised, ENTRY_LIMIT.recategorised),
      unchanged: asEffect(prediction.unchanged, ENTRY_LIMIT.unchanged),
      outranked: asEffect(prediction.outranked, ENTRY_LIMIT.outranked),
      introducedConflicts: prediction.introducedConflicts.map((c) => ({
        setId: c.setId,
        categories: [...c.categories],
        transactions: c.transactions,
        example: c.example,
      })),
      scanned: prediction.scanned,
    },
    ...(proposed === undefined
      ? {}
      : { proposed: proposed.map((p) => ({ setId: p.setId, version: p.version })) }),
    ...(applied === undefined
      ? {}
      : {
          applied: {
            scanned: applied.scanned,
            unchanged: applied.unchanged,
            appended: applied.appended,
            orphaned: applied.orphaned,
            uncategorised: applied.uncategorised,
            conflicts: applied.conflicts,
            inertRefines: applied.inertRefines,
          },
        }),
  };
}
