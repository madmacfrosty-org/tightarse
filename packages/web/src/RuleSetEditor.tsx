import { useState } from "react";
import type { CategoriesResponse, RuleView, StoredRuleSetView } from "@tightarse/api-contract";
import type { Api } from "./ports";
import { RuleChangePreview, useRuleChange } from "./rule-change";
import { describeMatcher } from "./RuleSets";

/**
 * Changing a set's rules.
 *
 * Staged, then previewed, then written. Nothing here touches the ledger until
 * the preview has been seen and confirmed — these rules decide the category of
 * years of transactions, and a dropdown that applied on change would
 * recategorise a household by accident.
 *
 * ## Only authored sets
 *
 * `authored` means never regenerated. The others — the shipped patterns, the
 * provider's own — are rebuilt, so an edit to one is work that disappears
 * silently at a time nobody chose. The caller decides what to show; this
 * refuses to render for an unauthored set rather than trusting it to.
 *
 * ## What can be edited, and what cannot
 *
 * The category, the direction and the note on any rule; the pattern on a
 * merchant rule. Deleting and reordering any rule, because order decides which
 * of two matching rules in a set is applied first and is otherwise
 * inexpressible.
 *
 * A matcher that is not a plain pattern — a conjunction, an amount band, one
 * transaction named outright — is shown and not editable. Those are five
 * shapes with their own rules about what is valid, and a half-built editor for
 * them would be a way to write a rule set that will not parse. Delete and
 * re-add through the tool that made it.
 *
 * ## The version
 *
 * Sent as it was read, which is what makes a stale edit fail rather than
 * silently reinstate the rules somebody else had just changed. A proposal
 * carries the whole set, so there is no merging to be done — the honest answer
 * to "this moved under you" is to say so and re-read.
 */

const DIRECTIONS: readonly RuleView["appliesTo"][] = ["debits", "credits", "all"];
const DIRECTION_LABEL: Record<RuleView["appliesTo"], string> = {
  debits: "money out",
  credits: "money in",
  all: "either direction",
};

/** Whether this rule's matcher is one the editor can safely change. */
export function patternOf(rule: RuleView): string | null {
  return rule.matcher.kind === "merchant" ? rule.matcher.pattern : null;
}

export function RuleSetEditor({
  api,
  set,
  categories,
  range,
  onApplied,
  onClose,
}: {
  api: Api;
  set: StoredRuleSetView;
  categories: CategoriesResponse["categories"];
  range: { from: string; to: string };
  onApplied: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RuleView[]>([...set.rules]);
  const change = useRuleChange(api, range, async () => {
    await onApplied();
    onClose();
  });

  const edit = (i: number, patch: Partial<RuleView>) =>
    setDraft((d) =>
      d.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        // An emptied note is no note. Spreading `{ note: undefined }` leaves
        // the key present, and the body is sent as an object rather than a
        // string — so the field would travel as an explicit undefined and the
        // schema would refuse it.
        if ("note" in patch && patch.note === undefined) delete next.note;
        return next;
      }),
    );

  const remove = (i: number) => setDraft((d) => d.filter((_, j) => j !== i));

  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const to = i + by;
      if (to < 0 || to >= d.length) return d;
      const next = [...d];
      const [row] = next.splice(i, 1);
      next.splice(to, 0, row!);
      return next;
    });

  const changed = JSON.stringify(draft) !== JSON.stringify(set.rules);

  const review = () =>
    void change.propose(
      {
        sets: [
          {
            setId: set.setId,
            // As read. The server decides the next number and refuses this if
            // the set has moved since.
            version: set.version,
            name: set.name,
            // Ignored by the server — precedence is the household's adoption
            // order and is not carried on a set.
            order: 0,
            authored: true,
            rules: draft,
          },
        ],
        because: "Edited from the dashboard",
      },
      `Changing ${draft.length} rule${draft.length === 1 ? "" : "s"} in ${set.name}`,
    );

  return (
    <div>
      {change.error !== null && <p className="error">{change.error}</p>}

      <div className="chart-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 64 }}>Order</th>
              <th>When</th>
              <th>File as</th>
              <th>Applies to</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.map((rule, i) => {
              const pattern = patternOf(rule);
              return (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`Move rule ${i} earlier`}
                      disabled={i === 0 || change.busy}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`Move rule ${i} later`}
                      disabled={i === draft.length - 1 || change.busy}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                  </td>
                  <td>
                    {pattern === null ? (
                      // Shown, not editable. Changing a conjunction or an
                      // amount band needs an editor for five shapes with their
                      // own validity rules, and a half-built one is a way to
                      // write a set that will not parse.
                      <span className="subtle">{describeMatcher(rule.matcher)}</span>
                    ) : (
                      <input
                        aria-label={`Pattern for rule ${i}`}
                        value={pattern}
                        disabled={change.busy}
                        onChange={(e) =>
                          edit(i, {
                            matcher: { kind: "merchant", pattern: e.target.value },
                          })
                        }
                      />
                    )}
                  </td>
                  <td>
                    <select
                      aria-label={`Category for rule ${i}`}
                      value={rule.contributes.category}
                      disabled={change.busy}
                      onChange={(e) =>
                        edit(i, {
                          contributes: { ...rule.contributes, category: e.target.value },
                        })
                      }
                    >
                      {/* The rule's own category first even if retired, so an
                          edit cannot silently repoint it at something else
                          just because the catalogue no longer offers it. */}
                      {categories.some((c) => c.id === rule.contributes.category) ? null : (
                        <option value={rule.contributes.category}>
                          {rule.contributes.category} (retired)
                        </option>
                      )}
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Direction for rule ${i}`}
                      value={rule.appliesTo}
                      disabled={change.busy}
                      onChange={(e) =>
                        edit(i, { appliesTo: e.target.value as RuleView["appliesTo"] })
                      }
                    >
                      {DIRECTIONS.map((d) => (
                        <option key={d} value={d}>
                          {DIRECTION_LABEL[d]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`Note for rule ${i}`}
                      value={rule.note ?? ""}
                      disabled={change.busy}
                      onChange={(e) =>
                        edit(i, e.target.value === "" ? { note: undefined } : { note: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`Delete rule ${i}`}
                      disabled={change.busy}
                      onClick={() => remove(i)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {draft.length === 0 && (
        <p className="note provisional">
          Every rule removed. Applying this leaves the set with none, which
          categorises nothing — the transactions it used to answer for fall to
          whichever set is next.
        </p>
      )}

      <div className="provider-row" style={{ gap: 8, marginTop: 8 }}>
        <button type="button" disabled={!changed || change.busy} onClick={review}>
          {change.busy ? "Working out…" : "Review change"}
        </button>
        <button type="button" className="ghost" disabled={change.busy} onClick={onClose}>
          Stop editing
        </button>
        {!changed && <span className="subtle">Nothing changed yet.</span>}
      </div>

      {change.pending !== null && (
        <RuleChangePreview
          change={change.pending}
          busy={change.busy}
          onConfirm={() => void change.confirm()}
          onCancel={change.cancel}
        />
      )}
    </div>
  );
}
