import { useState } from "react";
import { ProposalResponse, pathFor } from "@tightarse/api-contract";
import type { Api } from "./ports";

/**
 * Proposing a rule change, and showing what it would do before it is written.
 *
 * Shared, because there are now two ways to change the rules — categorise a
 * merchant, and edit a set directly — and they must not disagree about what a
 * confirmation means. One of them quietly skipping the preview, or wording the
 * conflict warning differently, is the kind of difference nobody notices until
 * it has already applied.
 *
 * `useRuleChange` is for a screen with no state of its own to collide with.
 * `Categorise` keeps its own propose and confirm because its `busy` flag is
 * shared with searching, and threading two of those through would be a worse
 * tangle than the twenty lines it saves. The preview itself is shared, which is
 * the part where a difference would mislead somebody.
 *
 * ## Always previewed
 *
 * Never applied straight from a button. The numbers are the point: a rule that
 * takes forty transactions you meant and three you did not is one you want to
 * see before it is written. The prediction is computed server-side against the
 * whole ledger and never taken from the caller, so this cannot flatter itself.
 */

/** A change asked about but not yet written. */
export interface RuleChange {
  /** The request body, held rather than rebuilt, so the thing confirmed is the thing asked about. */
  readonly body: Record<string, unknown>;
  /** What to call it on screen, in the middle of a sentence. */
  readonly what: string;
  readonly prediction: ProposalResponse["prediction"];
}

export interface UseRuleChange {
  readonly pending: RuleChange | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly applied: string | null;
  /** Ask what it would do. Writes nothing. */
  readonly propose: (body: Record<string, unknown>, what: string) => Promise<void>;
  /** Write it, accept it, recategorise the range. */
  readonly confirm: () => Promise<void>;
  readonly cancel: () => void;
  readonly clearApplied: () => void;
}

export function useRuleChange(
  api: Api,
  range: { from: string; to: string },
  /** Run after a successful apply, to re-read whatever is now out of date. */
  onApplied?: () => Promise<void> | void,
): UseRuleChange {
  const [pending, setPending] = useState<RuleChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const post = async (body: Record<string, unknown>, commit: "preview" | "apply") => {
    const q = new URLSearchParams({ ...range, commit }).toString();
    return api.post(ProposalResponse, `${pathFor("/categorisation/proposals")}?${q}`, body);
  };

  const propose = async (body: Record<string, unknown>, what: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post(body, "preview");
      setPending({ body, what, prediction: r.prediction });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not work out what that would do");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post(pending.body, "apply");
      setApplied(`${(r.applied?.appended ?? 0).toLocaleString("en-GB")} categorised.`);
      setPending(null);
      // What is on screen now says something out of date. Asking again is the
      // only way to show what the ledger says rather than what we hoped.
      await onApplied?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not apply that");
    } finally {
      setBusy(false);
    }
  };

  return {
    pending,
    busy,
    error,
    applied,
    propose,
    confirm,
    cancel: () => setPending(null),
    clearApplied: () => setApplied(null),
  };
}

/**
 * What the change would do, and the two buttons.
 *
 * Counts only. Which transactions change is a far longer answer than anybody
 * reads before pressing a button, and the four numbers here are the ones that
 * decide whether to.
 */
export function RuleChangePreview({
  change,
  busy,
  onConfirm,
  onCancel,
}: {
  change: RuleChange;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const n = (x: number) => x.toLocaleString("en-GB");
  const p = change.prediction;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2>Before this is written</h2>
      <p className="note">
        {change.what}. Measured against the whole ledger, not just what is on
        screen.
      </p>
      <table>
        <tbody>
          <tr>
            <td>Gain a category</td>
            <td className="num">{n(p.gained.transactions)}</td>
          </tr>
          <tr>
            <td>Change category</td>
            <td className="num">{n(p.recategorised.transactions)}</td>
          </tr>
          <tr>
            <td>Lose their category</td>
            <td className="num">{n(p.lost.transactions)}</td>
          </tr>
          <tr>
            <td>Already right</td>
            <td className="num">{n(p.unchanged.transactions)}</td>
          </tr>
        </tbody>
      </table>
      {p.introducedConflicts.length > 0 && (
        <p className="error" style={{ fontSize: 13 }}>
          This would make a rule set claim two answers at once, which produces
          none.
        </p>
      )}
      <div className="provider-row" style={{ gap: 8 }}>
        <button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Applying…" : "Confirm"}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
