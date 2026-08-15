import { useEffect, useState } from "react";
import { apiGet, completeSignIn, currentIdentity, signIn, signOut, type Identity } from "./auth";
import { ConnectBank, Connected } from "./Connect";
import { CategoryBars, MonthlyFlow, money } from "./charts";
import { netPosition, rangeFor, tileBalance } from "./positions";
import type { AccountView, Summary, TransactionView } from "@tightarse/api-contract";

const RANGES = [
  { label: "3 months", days: 90 },
  { label: "12 months", days: 365 },
  { label: "5 years", days: 365 * 5 },
] as const;

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

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [days, setDays] = useState<number>(365);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [txns, setTxns] = useState<TransactionView[]>([]);
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
    const { from, to } = rangeFor(days, new Date());
    const q = `?from=${from}&to=${to}`;
    setError(null);
    Promise.all([
      apiGet<Summary>(`/summary${q}`),
      apiGet<{ accounts: AccountView[] }>(`/accounts`),
      apiGet<{ transactions: TransactionView[] }>(`/transactions${q}&limit=60`),
    ])
      .then(([s, a, t]) => {
        setSummary(s);
        setAccounts(a.accounts ?? []);
        setTxns(t.transactions ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
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

  const { cardIds, net } = netPosition(accounts);

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
        <div className="tiles">
          {accounts.map((a) => (
            <div className="tile" key={a.accountId}>
              <div className="label">
                {cardIds.has(a.accountId) ? "Card" : "Account"} · {a.institutionName ?? "—"}
              </div>
              <div className="value">
                {tileBalance(a, cardIds.has(a.accountId)) === undefined
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
        <p className="note">Newest first.</p>
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
              {txns.map((t) => (
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
      </div>
    </div>
  );
}
