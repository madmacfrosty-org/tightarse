import { useEffect, useState } from "react";
import { RuleSetsResponse, pathFor } from "@tightarse/api-contract";
import type { MatcherView, RuleView, StoredRuleSetView } from "@tightarse/api-contract";
import type { Api } from "./ports";

/**
 * What is actually deciding the categories.
 *
 * Everything that changes rules already existed — a proposal takes whole sets
 * and previews what they would do — but nothing showed what the sets currently
 * are, which made the write path far less useful than it looked: to edit a set
 * you must send it as it would be, and the only way to learn what it is was a
 * terminal with the table name to hand.
 *
 * ## Why precedence is the headline
 *
 * A rule that matches does not necessarily win. Sets apply in the household's
 * adoption order, earliest first, and `assert` only establishes a category
 * where none is established yet — so an override beats the household set,
 * which beats the shipped patterns. When somebody asks "why is this filed
 * under groceries", the answer is almost always a set they were not looking
 * at, so the order is stated before anything else.
 *
 * ## Collapsed by default
 *
 * Seventy-odd rules across five sets is not a screen anybody reads top to
 * bottom. The sets are the index and the rules are the detail, so each set
 * opens on demand — except an unadopted one, which opens to nothing worth
 * reading anyway and says so in its summary.
 */

/** Minor units as money, for an amount matcher's bounds. */
function pounds(minorUnits: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(minorUnits / 100);
}

/**
 * A matcher in words.
 *
 * Closed algebra, five cases, so this is exhaustive rather than a best effort
 * with a fallback — and TypeScript holds it to that. A sixth case added to the
 * contract breaks this function at compile time, which is the point.
 *
 * Patterns are shown verbatim because a paraphrase of a regular expression is
 * a lie somebody will act on. `/…/i` says what it is and that it ignores case,
 * which `matches` does and nothing else on screen would tell you.
 */
export function describeMatcher(matcher: MatcherView): string {
  switch (matcher.kind) {
    case "merchant":
      return `description matches /${matcher.pattern}/i`;
    case "providerCategory":
      return `the bank's own category is "${matcher.value}"`;
    case "transaction":
      // One specific transaction, by the identity it was stored under. The key
      // is a hash and means nothing to read, so it is named rather than shown
      // in full — enough to tell two overrides apart, not enough to pretend it
      // is informative.
      return `one transaction (…${matcher.dedupKey.slice(-8)})`;
    case "amount": {
      const { min, max } = matcher;
      if (min !== undefined && max !== undefined) {
        return `amount is between ${pounds(min)} and ${pounds(max)}`;
      }
      if (min !== undefined) return `amount is at least ${pounds(min)}`;
      // The schema refuses a range open at both ends, so this is the max-only
      // case rather than a fallback.
      return `amount is at most ${pounds(max!)}`;
    }
    case "all":
      return matcher.of.map(describeMatcher).join(" and ");
  }
}

/** What a rule does when it matches, and to which direction. */
const DIRECTION: Record<RuleView["appliesTo"], string> = {
  debits: "money out",
  credits: "money in",
  all: "either direction",
};

function Rule({ rule, index }: { rule: RuleView; index: number }) {
  return (
    <tr>
      <td className="subtle" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        {index}
      </td>
      <td>{describeMatcher(rule.matcher)}</td>
      <td>
        <span className={`tag${rule.contributes.kind === "refine" ? " provisional" : ""}`}>
          {rule.contributes.category}
        </span>
      </td>
      <td className="subtle" style={{ whiteSpace: "nowrap" }}>
        {DIRECTION[rule.appliesTo]}
      </td>
      <td className="subtle">{rule.note ?? ""}</td>
    </tr>
  );
}

/** How a set stands for this household, in one line. */
function standing(set: StoredRuleSetView): string {
  if (!set.adopted) {
    return "not adopted — these rules apply to nothing";
  }
  const parts = [
    `applies ${set.precedence === 0 ? "first" : `${set.precedence! + 1}${ordinal(set.precedence! + 1)}`}`,
    `version ${set.version}`,
    set.authored ? "written by hand" : "generated",
  ];
  if (set.status !== "effective") parts.push(set.status);
  return parts.join(" · ");
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  if (n % 10 === 1) return "st";
  if (n % 10 === 2) return "nd";
  if (n % 10 === 3) return "rd";
  return "th";
}

function Set({ set }: { set: StoredRuleSetView }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        type="button"
        className="ghost"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ textAlign: "left", width: "100%" }}
      >
        {open ? "▾" : "▸"} {set.name}{" "}
        <span className="subtle">
          — {set.rules.length} rule{set.rules.length === 1 ? "" : "s"} · {standing(set)}
        </span>
      </button>
      {open &&
        (set.rules.length === 0 ? (
          <p className="note">No rules in this set.</p>
        ) : (
          <div className="chart-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "right" }}>#</th>
                  <th>When</th>
                  <th>File as</th>
                  <th>Applies to</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {set.rules.map((rule, i) => (
                  // Index as the key, and as the number shown. A rule carries
                  // no id of its own — it is a value, and its position is what
                  // the fold uses to order it — so position is the only honest
                  // way to name one.
                  <Rule key={i} rule={rule} index={i} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

export function RuleSets({ api }: { api: Api }) {
  const [data, setData] = useState<RuleSetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get(RuleSetsResponse, pathFor("/categorisation/rules"))
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Could not read the rules"),
      );
  }, [api]);

  return (
    <div className="card">
      <h2>The rules</h2>
      <p className="note">
        Sets apply in order, earliest winning, and a category once established is
        only changed by a rule that says it refines one. So a rule further down
        can match and still lose.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {error === null && data === null && <p className="note">Reading…</p>}
      {data !== null && data.sets.length === 0 && (
        <p className="note">
          No rule sets. Nothing is categorising, which is what a household that
          has adopted nothing gets.
        </p>
      )}
      {data?.sets.map((set) => (
        <Set key={set.setId} set={set} />
      ))}
      {data !== null && data.unreadable > 0 && (
        <p className="note provisional">
          {data.unreadable} stored set{data.unreadable === 1 ? "" : "s"} could not be
          read and {data.unreadable === 1 ? "is" : "are"} not listed above.{" "}
          {data.unreadable === 1 ? "It matches" : "They match"} nothing, so nothing is
          miscategorised — but a rule you remember writing may be in there.
        </p>
      )}
    </div>
  );
}
