import {
  PROVIDER_CATEGORIES,
  pathFor,
  type CategoryChoiceView,
  type ProposalResponse,
  type TransactionView,
} from "@tightarse/api-contract";
import { useEffect, useState } from "react";
import type { Api } from "./ports";

/**
 * Finding a merchant's transactions, and choosing which of them to categorise.
 *
 * The search is the rule. Type a merchant, see what it catches, and what is on
 * screen is what a rule built from that term would take — the server matches
 * with the same matcher the rules engine uses, so the list is not a resemblance
 * of the rule, it is the rule's output.
 *
 * Debits only, for now. A merchant's refunds are a different question and a
 * rule that quietly took them would be answering it without being asked.
 *
 * Nothing here writes. Choosing a category and proposing the rule comes next;
 * what this screen establishes is that the thing you are about to act on is
 * exactly the thing you can see.
 */

/** A render cap, not pagination — the same reason the dashboard has one. */
const PAGE = 50;

/**
 * The picker's escape hatch.
 *
 * A value no category id can be, since ids are slugs of a label and cannot
 * contain a space.
 */
const NEW = "new category";

/**
 * The set id a transaction carries when no rule claimed it.
 *
 * Uncategorised does not mean an empty category: the API reports the payment
 * rail — PURCHASE, DIRECT_DEBIT — marked provisional. What "nothing has
 * categorised this" actually means is that no rule set answered.
 */
const PROVIDER = "provider";

/**
 * A proposal waiting to be confirmed, and what it was predicted to do.
 *
 * Held rather than acted on, because the numbers are the point: a rule that
 * takes forty transactions you meant and three you did not is one you want to
 * see before it is written, not after.
 */
interface Proposal {
  readonly body: Record<string, unknown>;
  readonly what: string;
  readonly prediction: ProposalResponse["prediction"];
}

/**
 * What was asked for, as the server understands it.
 *
 * Held rather than re-read from the inputs, so that editing the boxes after a
 * search does not silently change what a button is about to write. The rule is
 * built from what was searched, not from what is currently typed.
 */
interface Filter {
  readonly term?: string;
  readonly type?: string;
  readonly min?: number;
  readonly max?: number;
}

/** Pounds as typed, to the pence the API wants. Empty is not a bound. */
const pence = (pounds: string): number | undefined => {
  const trimmed = pounds.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined;
};

const describe = (f: Filter): string => {
  const parts = [
    f.term === undefined ? undefined : `“${f.term}”`,
    f.type,
    f.min !== undefined && f.max !== undefined
      ? `£${(f.min / 100).toFixed(2)}–£${(f.max / 100).toFixed(2)}`
      : f.min !== undefined
        ? `over £${(f.min / 100).toFixed(2)}`
        : f.max !== undefined
          ? `under £${(f.max / 100).toFixed(2)}`
          : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.join(" · ");
};

const money = (minor: number) =>
  (Math.abs(minor) / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });

export function Categorise({ api, from, to }: { api: Api; from: string; to: string }) {
  const [term, setTerm] = useState("");
  const [type, setType] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [searched, setSearched] = useState<Filter | null>(null);
  const [rows, setRows] = useState<TransactionView[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [onlyUncategorised, setOnlyUncategorised] = useState(false);
  const [categories, setCategories] = useState<CategoryChoiceView[]>([]);
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<"spending" | "income" | "movement">("spending");
  const [pending, setPending] = useState<Proposal | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ categories: CategoryChoiceView[] }>(pathFor("/categories"))
      // Defensive at a boundary: a response without the field is a screen that
      // cannot offer a category, not a screen that throws while rendering.
      .then((r) => setCategories(r.categories ?? []))
      .catch(() => setError("Could not load categories"));
    // `api` is the injected port, bound once in main.tsx.
  }, [api]);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const wanted: Filter = {
      ...(term.trim().length > 0 ? { term: term.trim() } : {}),
      ...(type.length > 0 ? { type } : {}),
      ...(pence(min) === undefined ? {} : { min: pence(min) }),
      ...(pence(max) === undefined ? {} : { max: pence(max) }),
    };
    // Nothing asked for is not a search for everything: that is the whole
    // ledger, which is the dashboard's job and not this screen's.
    if (Object.keys(wanted).length === 0) return;
    await run(wanted);
  };

  const run = async (wanted: Filter) => {
    setBusy(true);
    setError(null);
    setPending(null);
    const q = new URLSearchParams({
      from,
      to,
      ...(wanted.term === undefined ? {} : { q: wanted.term }),
      ...(wanted.type === undefined ? {} : { type: wanted.type }),
      ...(wanted.min === undefined ? {} : { min: String(wanted.min) }),
      ...(wanted.max === undefined ? {} : { max: String(wanted.max) }),
    }).toString();
    try {
      const r = await api.get<{ transactions: TransactionView[] }>(`${pathFor("/transactions")}?${q}`);
      // Debits only. The API searches both directions because direction is the
      // rule's business, so the screen is where that choice is made.
      const debits = r.transactions.filter((t) => t.amount < 0);
      setRows(debits);
      // Everything, because categorising the lot is the case this exists for.
      // Unticking is how you say "not that one", not how you start.
      setSelected(new Set(debits.map((t) => t.dedupKey)));
      setSearched(wanted);
      setShown(PAGE);
    } catch (e: unknown) {
      // The old results go with it. Leaving them on screen under a fresh error
      // is an invitation to act on an answer to a different question.
      setRows([]);
      setSelected(new Set());
      setSearched(null);
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (dedupKey: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(dedupKey)) next.delete(dedupKey);
      else next.add(dedupKey);
      return next;
    });

  /** Ask what it would do. Writes nothing — `commit=preview`. */
  const propose = async (body: Record<string, unknown>, what: string) => {
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ from, to, commit: "preview" }).toString();
    try {
      const r = await api.post<ProposalResponse>(`${pathFor("/categorisation/proposals")}?${q}`, body);
      setPending({ body, what, prediction: r.prediction });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not work out what that would do");
    } finally {
      setBusy(false);
    }
  };

  /** Write it, accept it and recategorise — `commit=apply`. */
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ from, to, commit: "apply" }).toString();
    try {
      const r = await api.post<ProposalResponse>(
        `${pathFor("/categorisation/proposals")}?${q}`,
        pending.body,
      );
      setApplied(`${(r.applied?.appended ?? 0).toLocaleString("en-GB")} categorised.`);
      setPending(null);
      // The rows on screen now say something out of date. Ask again rather than
      // patching them here, so what is shown is what the ledger says.
      if (searched !== null) await run(searched);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not apply that");
    } finally {
      setBusy(false);
    }
  };

  // Every condition is optional, but a search with none of them is the whole
  // ledger — which is the dashboard's job, not this screen's.
  const nothingAsked =
    term.trim().length === 0 && type.length === 0 && pence(min) === undefined && pence(max) === undefined;
  /**
   * Add a category, then select it.
   *
   * Created before it is used rather than folded into the proposal: a rule
   * naming a category that does not exist is refused, so one invented inside a
   * proposal would be previewed against a catalogue that is not the one
   * applying it would use.
   */
  const addCategory = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<CategoryChoiceView>(pathFor("/categories"), {
        label: newLabel.trim(),
        kind: newKind,
      });
      setCategories((current) => [...current, made].sort((a, b) => a.label.localeCompare(b.label)));
      setCategory(made.id);
      setAdding(false);
      setNewLabel("");
    } catch (e: unknown) {
      // A taken name comes back with the existing label in it, which is the
      // sentence that says to pick that one instead.
      setError(e instanceof Error ? e.message : "Could not add that category");
    } finally {
      setBusy(false);
    }
  };

  /**
   * A view, not a filter on the search.
   *
   * Nothing here reaches a rule: a matcher sees what a transaction says about
   * itself, and a category is the result of evaluating rules rather than an
   * input to them — a rule saying "and it is currently uncategorised" would
   * stop matching the moment it applied.
   *
   * So this hides rows without touching the selection. Everything the search
   * matched stays selected, because the buttons act on the search and not on
   * what is being looked at; hiding rows and quietly deselecting them would
   * disable the merchant button exactly when someone had found what they were
   * looking for.
   */
  const uncategorised = (t: TransactionView) => t.setId === PROVIDER;
  const visible = onlyUncategorised ? rows.filter(uncategorised) : rows;
  const hidden = rows.length - visible.length;

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const credits = searched !== null && rows.length === 0;
  const chosen = categories.find((c) => c.id === category);

  return (
    <div className="card">
      <h2>Categorise a merchant</h2>
      <p className="note">
        Search for a merchant to see every transaction that matches. Debits only — a refund is a
        different question, and a rule that took it would be answering one you had not asked.
      </p>

      <form onSubmit={(e) => void search(e)}>
        <div className="provider-row" style={{ gap: 8 }}>
          <input
            aria-label="Merchant"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Merchant name"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="submit" disabled={busy || nothingAsked}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="provider-row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
          <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any type</option>
            {PROVIDER_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
          <input
            aria-label="Smallest amount"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder="£ from"
            inputMode="decimal"
            style={{ width: 90 }}
          />
          <input
            aria-label="Largest amount"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder="£ to"
            inputMode="decimal"
            style={{ width: 90 }}
          />
        </div>
      </form>

      {error ? <p className="error" style={{ padding: "12px 0 0", fontSize: 13 }}>{error}</p> : null}

      {searched !== null && !busy ? (
        <p className="note">
          {rows.length === 0
            ? `Nothing matches ${describe(searched)}.`
            : `${rows.length.toLocaleString("en-GB")} matching ${rows.length === 1 ? "transaction" : "transactions"}, ${selected.size.toLocaleString("en-GB")} selected${hidden > 0 ? `, ${hidden.toLocaleString("en-GB")} hidden` : ""}.`}
          {credits ? " Debits only — this merchant may still have credits." : ""}
        </p>
      ) : null}

      {applied ? <p className="note">{applied}</p> : null}

      {adding ? (
        <div className="provider-row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
          <input
            aria-label="New category"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Category name"
            style={{ flex: 1, minWidth: 0 }}
          />
          <select
            aria-label="What it does to the money"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as typeof newKind)}
          >
            <option value="spending">spending</option>
            <option value="income">income</option>
            <option value="movement">movement</option>
          </select>
          <button type="button" disabled={busy || newLabel.trim().length === 0} onClick={() => void addCategory()}>
            Add
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      {rows.length > 0 && pending === null ? (
        <div className="provider-row" style={{ gap: 8, alignItems: "center" }}>
          <label htmlFor="category" className="subtle">
            Categorise as
          </label>
          <select
            id="category"
            value={category}
            onChange={(e) => {
              if (e.target.value === NEW) {
                setAdding(true);
                setCategory("");
              } else {
                setCategory(e.target.value);
              }
            }}
            style={{ flex: 1, minWidth: 0 }}
          >
            <option value="">Choose a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            <option value={NEW}>New category…</option>
          </select>
          <button
            type="button"
            disabled={busy || category === "" || !allSelected}
            title={allSelected ? undefined : "Select every match, or categorise them individually"}
            onClick={() =>
              void propose(
                { merchant: { ...searched, category } },
                `everything matching ${describe(searched!)}`,
              )
            }
          >
            Categorise this merchant
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || category === "" || selected.size === 0}
            onClick={() =>
              void propose(
                { transactions: { dedupKeys: [...selected], category } },
                `${selected.size.toLocaleString("en-GB")} ${selected.size === 1 ? "transaction" : "transactions"}`,
              )
            }
          >
            Categorise {selected.size.toLocaleString("en-GB")} selected
          </button>
        </div>
      ) : null}

      {pending ? (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Before this is written</h2>
          <p className="note">
            Categorising {pending.what} as {chosen?.label ?? category}. Measured against the whole
            ledger, not just what is on screen.
          </p>
          <table>
            <tbody>
              <tr>
                <td>Gain a category</td>
                <td className="num">{pending.prediction.gained.transactions.toLocaleString("en-GB")}</td>
              </tr>
              <tr>
                <td>Change category</td>
                <td className="num">{pending.prediction.recategorised.transactions.toLocaleString("en-GB")}</td>
              </tr>
              <tr>
                <td>Lose their category</td>
                <td className="num">{pending.prediction.lost.transactions.toLocaleString("en-GB")}</td>
              </tr>
              <tr>
                <td>Already right</td>
                <td className="num">{pending.prediction.unchanged.transactions.toLocaleString("en-GB")}</td>
              </tr>
            </tbody>
          </table>
          {pending.prediction.introducedConflicts.length > 0 ? (
            <p className="error" style={{ fontSize: 13 }}>
              This would make a rule set claim two answers at once, which produces none.
            </p>
          ) : null}
          <div className="provider-row" style={{ gap: 8 }}>
            <button type="button" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Applying…" : "Confirm"}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <label className="subtle" style={{ display: "block", margin: "8px 0" }}>
            <input
              type="checkbox"
              checked={onlyUncategorised}
              onChange={(e) => setOnlyUncategorised(e.target.checked)}
            />{" "}
            Show only what nothing has categorised — hides rows, and changes neither the selection nor
            the rule
          </label>
          <div className="chart-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label={allSelected ? "Deselect all" : "Select all"}
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(rows.map((t) => t.dedupKey)))
                      }
                    />
                  </th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, shown).map((t) => (
                  <tr key={t.dedupKey}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.description}`}
                        checked={selected.has(t.dedupKey)}
                        onChange={() => toggle(t.dedupKey)}
                      />
                    </td>
                    <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {t.timestamp.slice(0, 10)}
                    </td>
                    <td>{t.description}</td>
                    <td>
                      <span className={`tag${t.setId === "provider" ? " provisional" : ""}`}>
                        {t.category}
                      </span>
                    </td>
                    <td className="num">{money(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown < visible.length ? (
            <button className="ghost" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown).toLocaleString("en-GB")} more
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
