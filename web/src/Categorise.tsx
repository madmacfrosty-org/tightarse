import {
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

const money = (minor: number) =>
  (Math.abs(minor) / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });

export function Categorise({ api, from, to }: { api: Api; from: string; to: string }) {
  const [term, setTerm] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [rows, setRows] = useState<TransactionView[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [categories, setCategories] = useState<CategoryChoiceView[]>([]);
  const [category, setCategory] = useState("");
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
    const wanted = term.trim();
    if (wanted.length === 0) return;
    await run(wanted);
  };

  const run = async (wanted: string) => {
    setBusy(true);
    setError(null);
    setPending(null);
    const q = new URLSearchParams({ from, to, q: wanted }).toString();
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

      <form onSubmit={(e) => void search(e)} className="provider-row" style={{ gap: 8 }}>
        <input
          aria-label="Merchant"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Merchant name"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="submit" disabled={busy || term.trim().length === 0}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error ? <p className="error" style={{ padding: "12px 0 0", fontSize: 13 }}>{error}</p> : null}

      {searched !== null && !busy ? (
        <p className="note">
          {rows.length === 0
            ? `Nothing matches “${searched}”.`
            : `${rows.length.toLocaleString("en-GB")} matching ${rows.length === 1 ? "transaction" : "transactions"}, ${selected.size.toLocaleString("en-GB")} selected.`}
          {credits ? " Debits only — this merchant may still have credits." : ""}
        </p>
      ) : null}

      {applied ? <p className="note">{applied}</p> : null}

      {rows.length > 0 && pending === null ? (
        <div className="provider-row" style={{ gap: 8, alignItems: "center" }}>
          <label htmlFor="category" className="subtle">
            Categorise as
          </label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <option value="">Choose a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || category === "" || !allSelected}
            title={allSelected ? undefined : "Select every match, or categorise them individually"}
            onClick={() => void propose({ merchant: { term: searched, category } }, `everything matching “${searched}”`)}
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
                {rows.slice(0, shown).map((t) => (
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
          {shown < rows.length ? (
            <button className="ghost" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown).toLocaleString("en-GB")} more
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
