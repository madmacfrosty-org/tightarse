import { useEffect, useState, type FormEvent } from "react";
import { apiGet, currentIdentity, initAuth, signIn, signOut, type Identity } from "./auth";
import { CategoryBars, MonthlyFlow, money, type CategoryDatum, type MonthDatum } from "./charts";

interface Summary {
  currency: string | null;
  from: string;
  to: string;
  transactionCount: number;
  income: number;
  spend: number;
  net: number;
  byCategory: CategoryDatum[];
  byMonth: MonthDatum[];
  internalTransfersNetted: boolean;
  transferCount: number;
  transferTotal: number;
  enrichedCount: number;
}

interface AccountRow {
  accountId: string;
  displayName: string;
  institutionName: string;
  currentBalance?: number;
  availableBalance?: number;
}

interface TxnRow {
  dedupKey: string;
  timestamp: string;
  description: string;
  amount: number;
  category: string;
  provisional: boolean;
}

const RANGES = [
  { label: "3 months", days: 90 },
  { label: "12 months", days: 365 },
  { label: "5 years", days: 365 * 5 },
] as const;

function SignIn({ onSignedIn }: { onSignedIn: (i: Identity) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    signIn(email, password)
      .then(onSignedIn)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Sign in failed"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="page" style={{ maxWidth: 360 }}>
      <h1>Tightarse</h1>
      <form className="card" onSubmit={submit}>
        <h2>Sign in</h2>
        <p className="note">Your household ledger.</p>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="label" htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {error ? <p className="error" style={{ padding: "12px 0 0", fontSize: 13 }}>{error}</p> : null}
      </form>
    </div>
  );
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [days, setDays] = useState<number>(365);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initAuth()
      .then(currentIdentity)
      .then(setIdentity)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Configuration failed"))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!identity) return;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const q = `?from=${from}&to=${to}`;
    setError(null);
    Promise.all([
      apiGet<Summary>(`/summary${q}`),
      apiGet<{ accounts: AccountRow[] }>(`/accounts`),
      apiGet<{ transactions: TxnRow[] }>(`/transactions${q}&limit=60`),
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
  if (!identity) return <SignIn onSignedIn={setIdentity} />;

  if (error) return <div className="page error">{error}</div>;
  if (!summary) return <div className="page loading">Loading…</div>;

  const cards = accounts.filter((a) => a.currentBalance !== undefined && a.availableBalance !== undefined
    && a.availableBalance > a.currentBalance && a.currentBalance > 0);
  const cardIds = new Set(cards.map((c) => c.accountId));
  const inCredit = accounts.filter((a) => !cardIds.has(a.accountId));
  const netCash = inCredit.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
  const owed = cards.reduce((s, a) => s + (a.currentBalance ?? 0), 0);

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
              onClick={() => { signOut(); setIdentity(null); }}
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
        <div className="hero" style={{ color: netCash + owed * -1 < 0 ? "var(--out)" : "var(--text-primary)" }}>
          {money(netCash - owed)}
        </div>
        <div className="tiles">
          {accounts.map((a) => (
            <div className="tile" key={a.accountId}>
              <div className="label">
                {cardIds.has(a.accountId) ? "Card" : "Account"} · {a.institutionName}
              </div>
              <div className="value">
                {a.currentBalance === undefined ? "—" : money(cardIds.has(a.accountId) ? -a.currentBalance : a.currentBalance)}
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
