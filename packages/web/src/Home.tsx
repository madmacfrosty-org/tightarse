import { useEffect, useState } from "react";
import type { Api } from "./ports";
import { BalanceLine, money } from "./charts";
import { Books } from "./Books";
import { ConsentNotice } from "./ConsentNotice";
import { netPosition, rangeFor, tileBalance } from "./positions";
import {
  AccountsResponse,
  BalancesResponse,
  BooksResponse,
  pathFor,
  TransactionsResponse,
  type AccountView,
  type ConsentView,
  type TransactionView,
} from "@tightarse/api-contract";

/**
 * The glance: where we stand, now, and how it has moved.
 *
 * Three months, and no control to change it. A glance answers without asking
 * anything first, and "which window?" is a question — choosing a period is
 * reviewing, and reviewing has `/spending`. The position itself is not a
 * function of the window at all: it is what the household is worth today.
 */
const GLANCE_DAYS = 90;

/**
 * How many transactions to put in the DOM at once.
 *
 * Not pagination — the whole range is already fetched, and at a few hundred
 * kilobytes that is fine. This is about rendering: a year is ~2,900 rows and
 * every one of them was going into the table. #28.
 */
const PAGE = 100;

/**
 * Did the API return less than was asked for?
 *
 * It clamps a request that reaches back past the point where every account has
 * data, because a total drawn earlier omits an account — for a card that means
 * missing debt, so the line reads high. Saying so is the difference between a
 * short chart and a chart that looks complete and is not.
 */
function clamped(balances: BalancesResponse, days: number): boolean {
  const asked = rangeFor(days, new Date());
  return balances.range.from > asked.from;
}

/**
 * Four requests, and only the four this page shows.
 *
 * The single page made five on every load against a dev account whose Lambda
 * concurrency limit is five. Splitting the pages splits the fan-out: the
 * summary this page never shows is `/spending`'s request now, and nothing here
 * asks for it.
 */
export function Home({ api }: { api: Api }) {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [consents, setConsents] = useState<ConsentView[]>([]);
  const [books, setBooks] = useState<BooksResponse | null>(null);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [txns, setTxns] = useState<TransactionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  // Dates, not a Date: two strings compare by value in a dependency array, so
  // this effect runs once per day rather than once per render.
  const { from, to } = rangeFor(GLANCE_DAYS, new Date());

  useEffect(() => {
    const q = `?from=${from}&to=${to}`;
    setError(null);
    Promise.all([
      api.get(BooksResponse, pathFor("/books")),
      api.get(AccountsResponse, pathFor("/accounts")),
      api.get(BalancesResponse, `${pathFor("/balances")}${q}`),
      // No `limit`: the API has never honoured one (#28), so asking for 60 and
      // rendering everything in range is what has always happened. A limit
      // without a cursor truncates rather than paginates — it hides rows with
      // no way to ask for the next ones — so the parameter goes rather than
      // gaining a server-side implementation. If a client ever needs less than
      // the full range on the wire, that is cursor-based pagination and a
      // contract change, not a bare parameter.
      api.get(TransactionsResponse, `${pathFor("/transactions")}${q}`),
    ])
      .then(([bk, a, b, t]) => {
        setBooks(bk);
        setAccounts(a.accounts ?? []);
        setConsents(a.consents ?? []);
        setBalances(b);
        setTxns(t.transactions ?? []);
        setLoaded(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [api, from, to]);

  if (error) return <div className="page error">{error}</div>;
  if (!loaded) return <div className="page loading">Loading…</div>;

  // Still the source of which accounts are cards and which have not said yet.
  // The total it also computes is no longer read: `/books` states that.
  const { cardIds, unknown, provisional } = netPosition(accounts);
  const unknownIds = new Set(unknown.map((a) => a.accountId));

  return (
    <>
      {/*
        Said before anything else, because it has a deadline and the numbers do
        not. Consent lapses every ninety days and nothing renews it; if the feed
        stops, every figure below goes quietly stale and still looks fine.

        The urgent half of the operator's work, on the page nobody has to be
        asked to open. The full list of connections lives on `/operations`.
      */}
      <ConsentNotice consents={consents} />

      {/* The one number the dashboard leads with — a hero figure, not a chart. */}
      <div className="card">
        <h2>Net position</h2>
        <p className="note">
          Every book whose position counts towards what the household is worth,
          added together — accounts and cards, and a loan where there is one.
        </p>
        {/*
          One computation, not two. This used to be cash less cards, computed
          here from the account tiles while `/books` computed the same figure a
          different way. They agreed, which is exactly how two of them survive
          until the day they quietly stop. A category that is an asset or a
          liability now counts, which the account-only version could not express.
        */}
        {books === null ? (
          <div className="hero subtle">…</div>
        ) : (
          <div
            className="hero"
            style={{
              color:
                books.householdPosition < 0
                  ? "var(--out)"
                  : "var(--text-primary)",
            }}
          >
            {money(books.householdPosition)}
          </div>
        )}
        {/*
          Said plainly rather than shown as a footnote. An account whose type is
          not known yet is left out of this figure entirely (#29) — counting it
          as cash was wrong by twice the balance whenever it turned out to be a
          card, so the number is short rather than wrong, and it should not look
          authoritative while it is.
        */}
        {provisional && (
          <p className="note provisional">
            {unknown.length === 1 ? "One account is" : `${unknown.length} accounts are`} still
            syncing and not included — this figure is incomplete.
          </p>
        )}
        <div className="tiles">
          {accounts.map((a) => (
            <div className="tile" key={a.accountId}>
              <div className="label">
                {unknownIds.has(a.accountId)
                  ? "Syncing"
                  : cardIds.has(a.accountId)
                    ? "Card"
                    : "Account"}{" "}
                · {a.institutionName ?? "—"}
              </div>
              <div className="value">
                {/*
                  A balance whose sign depends on a flag we do not have yet is
                  not a balance we can show. Which way a card signs is the whole
                  question, so an unclassified account shows nothing rather than
                  a number that is plausible and possibly inverted.
                */}
                {unknownIds.has(a.accountId) || tileBalance(a, cardIds.has(a.accountId)) === undefined
                  ? "—"
                  : money(tileBalance(a, cardIds.has(a.accountId))!)}
              </div>
              <div className="meta">
                {a.availableBalance === undefined
                  ? a.accountId.slice(0, 8)
                  : `${money(a.availableBalance)} available`}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Balance over time</h2>
        <p className="note">
          Cash less card debt, every day.
          {balances?.range && (
            <>
              {" "}
              From <strong>{balances.range.from}</strong>
              {clamped(balances, GLANCE_DAYS) && " — as far back as every account has data"}.
            </>
          )}
        </p>
        {balances?.points ? <BalanceLine data={[...balances.points]} /> : <p className="subtle">Loading…</p>}
      </div>

      {/*
        The headline broken out. Same response, same arithmetic — an account, a
        category and a loan are one kind of thing, and this is the figure above
        with its parts named rather than a second view of the ledger.
      */}
      <div className="card">
        <Books data={books} />
      </div>

      <div className="card">
        <h2>Recent transactions</h2>
        <p className="note">
          Newest first, over the last three months. Showing{" "}
          {Math.min(shown, txns.length).toLocaleString("en-GB")} of{" "}
          {txns.length.toLocaleString("en-GB")}.
        </p>
        <div className="chart-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {txns.slice(0, shown).map((t) => (
                <tr key={t.dedupKey}>
                  <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {t.timestamp.slice(0, 10)}
                  </td>
                  <td>{t.description}</td>
                  <td>
                    <span className={`tag${t.setId === "provider" ? " provisional" : ""}`}>{t.category}</span>
                  </td>
                  <td className="num" style={{ color: t.amount < 0 ? "var(--text-primary)" : "var(--in)" }}>
                    {money(t.amount, { sign: t.amount > 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/*
          A render cap, not pagination. Every transaction in range is already
          here — a year is a few hundred kilobytes and that is fine — but
          putting ~2,900 rows in the DOM at once is what a phone actually
          feels. #28.
        */}
        {shown < txns.length && (
          <button className="ghost" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, txns.length - shown)} more
          </button>
        )}
      </div>
    </>
  );
}
