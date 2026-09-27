import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Api } from "./ports";
import { CategoryBars, MonthlyFlow, money } from "./charts";
import { rangeFor } from "./positions";
import {
  AccountsResponse,
  pathFor,
  SummaryResponse,
  type Summary,
} from "@tightarse/api-contract";

const RANGES = [
  { id: "3m", label: "3 months", days: 90 },
  { id: "12m", label: "12 months", days: 365 },
  // Not a fixed span. How far back a total is trustworthy is set by the
  // shallowest account and grows a day at a time as history accrues, so the
  // API is asked and the answer used. A fixed "5 years" was wrong in both
  // directions: too long today, and too short once the window widens. #33.
  { id: "all", label: "All time", days: Number.POSITIVE_INFINITY },
] as const;

const DEFAULT = RANGES[1];

/**
 * The chosen range, read from the address.
 *
 * In the address rather than in a hook, so a review can be linked to and
 * returned to. A page whose address is the same whatever it is showing has to
 * be reconstructed every time, which is most of the cost of doing a review.
 *
 * An unrecognised value falls back to the default rather than erroring: it is a
 * presentation choice arriving from outside, and the worst it can be is stale.
 */
function chosen(params: URLSearchParams): (typeof RANGES)[number] {
  const id = params.get("range");
  return RANGES.find((r) => r.id === id) ?? DEFAULT;
}

/**
 * Where the money went, over a period you choose.
 *
 * The range lives here and nowhere else. On `/` it does not exist, because a
 * position is a statement about now — this is the page where picking a window
 * is the whole point.
 */
export function Spending({ api }: { api: Api }) {
  const [params, setParams] = useSearchParams();
  const [summary, setSummary] = useState<Summary | null>(null);
  // Range-independent, so it survives a range change and is known before "All
  // time" can be chosen. That is what lets that option ask for the window
  // itself rather than for everything and hoping the server trims it.
  const [completeFrom, setCompleteFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const range = chosen(params);

  useEffect(() => {
    api
      .get(AccountsResponse, pathFor("/accounts"))
      .then((a) => setCompleteFrom(a.completeFrom ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [api]);

  // "All time" means `completeFrom`, not "everything".
  //
  // Asking for fifty years and letting the server trim worked for the chart,
  // which clamps, and broke the transaction list, which does not: the full
  // history is over Lambda's 6MB response limit, so the request failed with a
  // 500 after several seconds. Asking for the window we already know about
  // keeps every panel on the same range and the response inside the limit.
  //
  // Null until that window is known, which is the case a linked `?range=all`
  // arrives in: the request waits rather than quietly reporting twelve months
  // under a heading promising everything.
  const from = Number.isFinite(range.days)
    ? rangeFor(range.days, new Date()).from
    : completeFrom;
  const to = rangeFor(0, new Date()).to;

  useEffect(() => {
    // Two strings, so this depends on the window rather than on the state that
    // computes it: `completeFrom` arriving does not re-run a request whose
    // range it did not change. Listing it as a dependency fetched everything
    // twice on every load.
    if (from === null) return;
    setError(null);
    api
      .get(SummaryResponse, `${pathFor("/summary")}?from=${from}&to=${to}`)
      .then(setSummary)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [api, from, to]);

  if (error) return <div className="page error">{error}</div>;
  if (!summary) return <div className="page loading">Loading…</div>;

  return (
    <>
      <div className="card">
        <h2>The period</h2>
        <p className="note">
          {summary.from} to {summary.to} ·{" "}
          {summary.transactionCount.toLocaleString("en-GB")} transactions
        </p>
        <div className="legend" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              // "All time" means the window every account covers, so it cannot
              // be offered before that is known. It arrives with the first
              // load; until then the button would silently show twelve months.
              disabled={r.id === "all" && completeFrom === null}
              onClick={() => setParams({ range: r.id })}
              aria-pressed={range.id === r.id}
              style={{
                background: range.id === r.id ? "var(--surface-1)" : "transparent",
                border: "1px solid var(--border)",
                color: range.id === r.id ? "var(--text-primary)" : "var(--text-secondary)",
                borderRadius: 999,
                padding: "4px 12px",
                font: "inherit",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Money in and out</h2>
        <p className="note">
          Transfers between your own accounts are excluded — {summary.transferCount} legs,{" "}
          {money(summary.transferTotal)} moved. Net position is unaffected by that netting.
        </p>
        {summary.balanceSheetCount > 0 && (
          <p className="note">
            {/*
              Said out loud for the same reason the transfer line is. Excluding a
              category from spending is the one change here that can make a
              figure quietly smaller, and a total that shrank silently would be
              indistinguishable from one that was right. See #109.
            */}
            A further {summary.balanceSheetCount}{" "}
            {summary.balanceSheetCount === 1 ? "transaction" : "transactions"} moved
            rather than were spent — {money(summary.balanceSheetTotal)} filed to
            savings, a loan or another book you own. Money you still have does not
            count as spending.
          </p>
        )}
        <div className="legend">
          <span><i className="swatch" style={{ background: "var(--in)" }} /> money in</span>
          <span><i className="swatch" style={{ background: "var(--out)" }} /> money out</span>
        </div>
        <MonthlyFlow data={summary.byMonth} />
      </div>

      <div className="card">
        <h2>Where it goes</h2>
        <p className="note">
          {summary.enrichedCount.toLocaleString("en-GB")} of{" "}
          {summary.transactionCount.toLocaleString("en-GB")} transactions have a real category.
          Greyed rows are the bank&rsquo;s payment type, not a spending category.
        </p>
        <CategoryBars data={summary.byCategory} />
      </div>
    </>
  );
}
