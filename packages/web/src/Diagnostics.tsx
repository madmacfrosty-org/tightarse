import {
  pathFor,
  type RunningBalanceResponse,
  type AccountBalanceCheck,
  type Displacement,
} from "@tightarse/api-contract";
import { useState } from "react";
import type { Api } from "./ports";

/**
 * What the provider's running balance actually means.
 *
 * The provider documents that a transaction may carry a running balance and
 * never says whether it is the position before or after that transaction. The
 * ledger assumes "after" in three separate places and derives every account
 * balance from it, and nothing that runs today would catch the assumption being
 * wrong — reconciliation compares balance readings against summed amounts and
 * never looks at a running balance at all.
 *
 * So this asks the household's own data. If a running balance is a closing
 * position then a day's closing less the previous day's is exactly that day's
 * movement, and the arithmetic can be checked by eye against a statement.
 *
 * Loaded on a click rather than with the dashboard: it reads the whole history
 * of every account, which is not a cost to pay on every page load for a question
 * that is asked rarely.
 */

const VERDICTS: Record<string, string> = {
  closing:
    "The balance is the position AFTER its transaction. This is what the ledger assumes, so derived balances are sound.",
  opening:
    "The balance is the position BEFORE its transaction. Every derived balance is out by one transaction, and the chart has been wrong.",
  ambiguous:
    "The data cannot tell: every consecutive pair carries the same amount, so both readings predict the same chain.",
  inconsistent:
    "The chain does not hold either way. Something is wrong with the ledger rather than with the reading: either a transaction is absent, or one is filed under a date the bank did not use. Displacements below tell those apart.",
  insufficient:
    "Nothing to compare. Cards carry no running balance at all, so this is expected for them.",
};

/** Minor units to pounds, for display only. */
const money = (minor: number): string =>
  `${minor < 0 ? "−" : ""}£${(Math.abs(minor) / 100).toFixed(2)}`;

/**
 * One misdating, in the form a reader can take to their banking app.
 *
 * The amount and the date narrow it down; the description is what actually
 * identifies the row by eye, which is why it is here.
 */
function DisplacedRow({ d }: { d: Displacement }) {
  const earlier = d.displacedBy > 0;
  const gap = Math.abs(d.displacedBy);
  return (
    <li className="displacement">
      {d.candidates.length === 0 ? (
        <p>
          <strong>{money(d.amount)}</strong> moved on {d.bankDate}, but our
          ledger accounts for it on {d.ledgerDate}. We hold no single
          transaction of that amount on that day — so this looks like something
          absent rather than something misfiled.
        </p>
      ) : (
        <>
          <p>
            The bank applied this on <strong>{d.bankDate}</strong>; we date it{" "}
            <strong>{d.ledgerDate}</strong> — {gap} day{gap === 1 ? "" : "s"}{" "}
            {earlier ? "later than the bank" : "earlier than the bank"}.
          </p>
          <table>
            <thead>
              <tr>
                <th>Our date</th>
                <th>Description</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.candidates.map((c) => (
                <tr key={c.dedupKey}>
                  <td>{c.timestamp.slice(0, 10)}</td>
                  <td>{c.description}</td>
                  <td>{c.merchantName ?? "—"}</td>
                  <td>{money(c.amount)}</td>
                  <td>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.candidates.length > 1 && (
            <p className="muted">
              More than one transaction that day matches this amount exactly, so
              the arithmetic alone cannot say which.
            </p>
          )}
        </>
      )}
    </li>
  );
}

function AccountRow({ account }: { account: AccountBalanceCheck }) {
  // Days a displacement already accounts for. Showing them again in the
  // unexplained table would double-count the same fault.
  const explained = new Set(
    account.displacements.flatMap((d) => [d.ledgerDate, d.bankDate]),
  );
  const unexplained = account.disagreeing.filter((d) => !explained.has(d.date));
  // Pairs that cannot tell the two readings apart match both by construction,
  // so they inflate the losing count. When every "opening" match is one of
  // those, nothing that carries information supports it.
  const uninformative = account.pairs - account.discriminating;
  return (
    <div className="diagnostic-account">
      <h4>
        {account.accountId}
        {account.isCard ? " (card)" : ""} — <strong>{account.verdict}</strong>
      </h4>
      <p className="muted">
        {account.pairs} consecutive pairs, {account.discriminating} of them able
        to tell the two readings apart. Closing matched {account.closingMatches},
        opening matched {account.openingMatches}. {account.daysChecked} days
        compared.
      </p>
      {account.openingMatches > 0 &&
        account.openingMatches <= uninformative && (
          <p className="muted">
            Every pair matching &ldquo;opening&rdquo; is one that cannot tell the
            two readings apart, so it matches both. No pair carrying information
            supports it.
          </p>
        )}
      {account.displacements.length > 0 && (
        <>
          <p>
            {account.displacements.length} pair
            {account.displacements.length === 1 ? "" : "s"} of days that cancel
            exactly — one transaction, counted once, on a date the bank did not
            use:
          </p>
          <ul className="displacements">
            {account.displacements.map((d) => (
              <DisplacedRow key={`${d.bankDate}:${d.ledgerDate}`} d={d} />
            ))}
          </ul>
        </>
      )}
      {unexplained.length > 0 && (
        <>
          <p>
            {unexplained.length} day
            {unexplained.length === 1 ? "" : "s"} where the balance moved by
            something other than that day&apos;s transactions, and nothing
            cancels them:
          </p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Previous close</th>
                <th>Close</th>
                <th>Movement</th>
                <th>Unexplained</th>
              </tr>
            </thead>
            <tbody>
              {unexplained.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{money(d.previousClosing)}</td>
                  <td>{money(d.closing)}</td>
                  <td>{money(d.movement)}</td>
                  <td>{money(d.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function Diagnostics({ api }: { api: Api }) {
  const [report, setReport] = useState<RunningBalanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api
      .get<RunningBalanceResponse>(pathFor("/diagnostics/running-balance"))
      .then(setReport)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to run the check"),
      )
      .finally(() => setLoading(false));
  };

  return (
    <section className="diagnostics">
      <h3>What does the running balance mean?</h3>
      <p className="muted">
        The provider never documents whether a transaction&apos;s running balance
        is the position before or after it. Every balance on this dashboard
        assumes &ldquo;after&rdquo;. This checks that against the ledger itself.
      </p>
      <button onClick={run} disabled={loading}>
        {loading ? "Checking…" : "Run the check"}
      </button>
      {error && <p className="error">{error}</p>}
      {report && (
        <>
          <p>
            <strong>Verdict: {report.verdict}</strong>
          </p>
          <p>{VERDICTS[report.verdict]}</p>
          {report.accounts.map((a) => (
            <AccountRow key={a.accountId} account={a} />
          ))}
        </>
      )}
    </section>
  );
}
