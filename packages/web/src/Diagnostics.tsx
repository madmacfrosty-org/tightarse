import {
  pathFor,
  type RunningBalanceResponse,
  type AccountBalanceCheck,
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
    "The chain does not hold either way, which means a transaction is missing rather than that the field is misread.",
  insufficient:
    "Nothing to compare. Cards carry no running balance at all, so this is expected for them.",
};

/** Minor units to pounds, for display only. */
const money = (minor: number): string =>
  `${minor < 0 ? "−" : ""}£${(Math.abs(minor) / 100).toFixed(2)}`;

function AccountRow({ account }: { account: AccountBalanceCheck }) {
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
      {account.disagreeing.length > 0 && (
        <>
          <p>
            {account.disagreeing.length} day
            {account.disagreeing.length === 1 ? "" : "s"} where the balance moved
            by something other than that day&apos;s transactions:
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
              {account.disagreeing.map((d) => (
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
