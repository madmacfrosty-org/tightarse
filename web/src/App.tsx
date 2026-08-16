import { useEffect, useState } from "react";
import { apiGet, completeSignIn, currentIdentity, signIn, signOut, type Identity } from "./auth";
import { ConnectBank, Connected } from "./Connect";
import { BalanceLine, CategoryBars, MonthlyFlow, money } from "./charts";
import { netPosition, rangeFor, tileBalance } from "./positions";
import {
  pathFor,
  type AccountView,
  type BalancesResponse,
  type Summary,
  type TransactionView,
} from "@tightarse/api-contract";

const RANGES = [
  { label: "3 months", days: 90 },
  { label: "12 months", days: 365 },
  // Not a fixed span. How far back a total is trustworthy is set by the
  // shallowest account and grows a day at a time as history accrues, so the
  // API is asked and the answer used. A fixed "5 years" was wrong in both
  // directions: too long today, and too short once the window widens. #33.
  { label: "All time", days: Number.POSITIVE_INFINITY },
] as const;

/**
 * How many transactions to put in the DOM at once.
 *
 * Not pagination — the whole range is already fetched, and at a few hundred
 * kilobytes that is fine. This is about rendering: a year is ~2,900 rows and
 * every one of them was going into the table. #28.
 */
const PAGE = 100;

function SignIn({ error }: { error: string | null }) {
  return (
    <div className="page" style={{ maxWidth: 380 }}>
      <h1>Tightarse</h1>
      <div className="card">
        <h2>Sign in</h2>
        <p className="note">
          Your household ledger. Sign in with Google, or with an email and password.
        </p>
        <button type="submit" onClick={() => void signIn()}>Continue to sign in</button>
        {error ? <p className="error" style={{ padding: "12px 0 0", fontSize: 13 }}>{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * Did the API return less than was asked for?
 *
 * It clamps a request that reaches back past the point where every account has
 * data, because a total drawn earlier omits an account — for a card that means
 * missing debt, so the line reads high. Saying so is the difference between a
 * short chart and a chart that looks complete and is not.
 */
function clamped(balances: BalancesResponse, days: number): boolean {
  const asked = rangeFor(Number.isFinite(days) ? days : 365 * 50, new Date());
  return balances.range.from > asked.from;
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [days, setDays] = useState<number>(365);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [txns, setTxns] = useState<TransactionView[]>([]);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  // Range-independent, so it survives a range change and is known before "All
  // time" can be chosen. That is what lets that option ask for the window
  // itself rather than for everything and hoping the server trims it.
  const [completeFrom, setCompleteFrom] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Safe on every load: returns null when this is not a redirect back.
    completeSignIn()
      .then((fromRedirect) => fromRedirect ?? currentIdentity())
      .then(setIdentity)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Sign in failed"))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!identity) return;
    // "All time" means `completeFrom`, not "everything".
    //
    // Asking for fifty years and letting the server trim worked for the chart,
    // which clamps, and broke the transaction list, which does not: the full
    // history is over Lambda's 6MB response limit, so the request failed with a
    // 500 after several seconds. Asking for the window we already know about
    // keeps every panel on the same range and the response inside the limit.
    const window = rangeFor(365, new Date());
    const { from, to } = Number.isFinite(days)
      ? rangeFor(days, new Date())
      : { from: completeFrom ?? window.from, to: window.to };
    const q = `?from=${from}&to=${to}`;
    setError(null);
    setShown(PAGE);
    Promise.all([
      apiGet<Summary>(`${pathFor("/summary")}${q}`),
      apiGet<{ accounts: AccountView[]; completeFrom?: string }>(pathFor("/accounts")),
      // No `limit`: the API has never honoured one (#28), so asking for 60 and
      // rendering everything in range is what has always happened. A limit
      // without a cursor truncates rather than paginates — it hides rows with
      // no way to ask for the next ones — so the parameter goes rather than
      // gaining a server-side implementation. If a client ever needs less than
      // the full range on the wire, that is cursor-based pagination and a
      // contract change, not a bare parameter.
      apiGet<{ transactions: TransactionView[] }>(`${pathFor("/transactions")}${q}`),
      apiGet<BalancesResponse>(`${pathFor("/balances")}${q}`),
    ])
      .then(([s, a, t, b]) => {
        setSummary(s);
        setAccounts(a.accounts ?? []);
        setTxns(t.transactions ?? []);
        setBalances(b);
        setCompleteFrom(a.completeFrom ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
    // `completeFrom` is deliberately not a dependency. It is set by this very
    // effect, so listing it would re-run the whole load the moment it arrives —
    // two fetches of everything on every page load. The effect is recreated
    // when `days` changes, which is the only time its value is read, so it is
    // current when it matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, identity]);

  if (checking) return <div className="page loading">Checking session…</div>;
  if (error && !identity) return <div className="page error">{error}</div>;
  // The provider redirects here after a bank authorisation. Checked before the
  // sign-in gate so a returning redirect is never mistaken for a fresh visit.
  if (identity && window.location.pathname === "/connected") {
    return <Connected onFinished={() => window.location.assign("/")} />;
  }
  if (!identity) return <SignIn error={error} />;

  if (error) return <div className="page error">{error}</div>;
  if (!summary) return <div className="page loading">Loading…</div>;

  const { cardIds, net, unknown, provisional } = netPosition(accounts);
  const unknownIds = new Set(unknown.map((a) => a.accountId));

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Tightarse</h1>
          <div className="subtle">
            {summary.from} to {summary.to} · {summary.transactionCount.toLocaleString("en-GB")} transactions
            {" · "}
            {identity.email}
            {" · "}
            <button
              onClick={() => void signOut()}
              style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--in)", cursor: "pointer" }}
            >
              sign out
            </button>
          </div>
        </div>
        <div className="legend" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              // "All time" means the window every account covers, so it cannot
              // be offered before that is known. It arrives with the first
              // load; until then the button would silently show twelve months.
              disabled={!Number.isFinite(r.days) && completeFrom === null}
              onClick={() => setDays(r.days)}
              aria-pressed={days === r.days}
              style={{
                background: days === r.days ? "var(--surface-1)" : "transparent",
                border: "1px solid var(--border)",
                color: days === r.days ? "var(--text-primary)" : "var(--text-secondary)",
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
      </header>

      {/* The one number the dashboard leads with — a hero figure, not a chart. */}
      <div className="card">
        <h2>Net position</h2>
        <p className="note">
          Cash across current accounts, less anything owed on cards.
        </p>
        <div className="hero" style={{ color: net < 0 ? "var(--out)" : "var(--text-primary)" }}>
          {money(net)}
        </div>
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
              {clamped(balances, days) && " — as far back as every account has data"}.
            </>
          )}
        </p>
        {balances?.points ? <BalanceLine data={[...balances.points]} /> : <p className="subtle">Loading…</p>}
      </div>

      <div className="card">
        <h2>Money in and out</h2>
        <p className="note">
          Transfers between your own accounts are excluded — {summary.transferCount} legs,{" "}
          {money(summary.transferTotal)} moved. Net position is unaffected by that netting.
        </p>
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

      <ConnectBank />

      <div className="card">
        <h2>Recent transactions</h2>
        <p className="note">
          Newest first. Showing {Math.min(shown, txns.length).toLocaleString("en-GB")} of{" "}
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
                    <span className={`tag${t.provisional ? " provisional" : ""}`}>{t.category}</span>
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
    </div>
  );
}
