import { useCallback, useEffect, useState } from "react";
import {
  AccountsResponse,
  JoinAccountsResponse,
  SeparateAccountResponse,
  pathFor,
} from "@tightarse/api-contract";
import type { AccountView } from "@tightarse/api-contract";
import type { Api } from "./ports";

/**
 * The accounts the household holds, and which of them are really one account.
 *
 * A bank renames an account when a card is reissued, and the app joins the two
 * so the history carries on. That is almost always right and was completely
 * invisible: two of this household's cards were joined in November and nothing
 * on any screen said so. A join files one account's transactions under another
 * and the total reads entirely plausibly either way, which is exactly why it
 * cannot be silent. #199.
 *
 * So this says what was joined, on whose say-so, and offers to undo it. And it
 * offers the join the automatic match cannot make: that needs two transactions
 * in common, which an account renamed while dormant will never have.
 *
 * On Operations rather than the dashboard. Nobody needs this at a glance — it
 * is read when a figure looks wrong, which is the same errand as suspending a
 * connection or changing who has access.
 */

function Continued({
  of,
  busy,
  onSeparate,
}: {
  of: NonNullable<AccountView["continues"]>;
  busy: boolean;
  onSeparate: (accountId: string) => void;
}) {
  return (
    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
      {of.map((c) => (
        <li key={c.accountId} className="subtle">
          Continues <strong>{c.displayName ?? c.accountId.slice(0, 8)}</strong>
          {c.since !== undefined && ` since ${c.since.slice(0, 10)}`}.{" "}
          {c.joinedBy !== undefined
            ? `Joined by ${c.joinedBy}.`
            : c.sharedTransactions !== undefined
              ? `Matched on ${c.sharedTransactions.toLocaleString("en-GB")} transaction${
                  c.sharedTransactions === 1 ? "" : "s"
                } they both hold.`
              : "Joined."}{" "}
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => onSeparate(c.accountId)}
          >
            Separate
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Accounts({ api }: { api: Api }) {
  const [accounts, setAccounts] = useState<readonly AccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [gone, setGone] = useState("");
  const [into, setInto] = useState("");

  const read = useCallback(async () => {
    try {
      const r = await api.get(AccountsResponse, pathFor("/accounts"));
      setAccounts(r.accounts);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not read the accounts");
    }
  }, [api]);

  useEffect(() => {
    void read();
  }, [read]);

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      // Re-read rather than patch what is on screen. A join changes which
      // transactions count towards which balance, and every figure here is
      // downstream of that.
      await read();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(false);
    }
  };

  const separate = (accountId: string) =>
    void act(() =>
      api.post(SeparateAccountResponse, pathFor("/accounts/separate"), { accountId }),
    );

  const join = () =>
    void act(async () => {
      await api.post(JoinAccountsResponse, pathFor("/accounts/join"), {
        supersededId: gone,
        survivingId: into,
      });
      setJoining(false);
      setGone("");
      setInto("");
    });

  const name = (a: AccountView) =>
    a.displayName ?? a.institutionName ?? a.accountId.slice(0, 8);

  return (
    <div className="card">
      <h2>Accounts</h2>
      <p className="note">
        When a card is replaced the bank gives the same account a new identity.
        Where that has been spotted, the two are read as one account and the
        history carries on — this says where, and lets it be undone.
      </p>

      {error !== null && <p className="error">{error}</p>}
      {error === null && accounts === null && <p className="note">Reading…</p>}

      {accounts !== null && accounts.length === 0 && (
        <p className="note">No accounts yet. Connect a bank first.</p>
      )}

      {accounts !== null && accounts.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {accounts.map((a) => (
            <li key={a.accountId} style={{ marginBottom: 12 }}>
              <strong>{name(a)}</strong>{" "}
              <span className="subtle">
                {a.institutionName !== undefined && a.displayName !== undefined
                  ? `${a.institutionName} · `
                  : ""}
                {a.isCard === true ? "card" : a.isCard === false ? "account" : "syncing"}
              </span>
              {a.continues !== undefined && a.continues.length > 0 && (
                <Continued of={a.continues} busy={busy} onSeparate={separate} />
              )}
            </li>
          ))}
        </ul>
      )}

      {accounts !== null && accounts.length > 0 && !joining && (
        <button type="button" className="ghost" disabled={busy} onClick={() => setJoining(true)}>
          Join two accounts by hand
        </button>
      )}

      {joining && accounts !== null && (
        <div style={{ marginTop: 8 }}>
          <p className="note">
            For an account the bank renamed while nothing was going in or out of
            it — there are no shared transactions to find it by, so it has to be
            said. The first account&rsquo;s history is read under the second from
            then on. Reversible.
          </p>
          <div className="provider-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label>
              <span className="subtle">The account that stopped</span>{" "}
              <select
                aria-label="The account that stopped"
                value={gone}
                disabled={busy}
                onChange={(e) => setGone(e.target.value)}
              >
                <option value="">Choose…</option>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {name(a)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="subtle">continues into</span>{" "}
              <select
                aria-label="The account it continues into"
                value={into}
                disabled={busy}
                onChange={(e) => setInto(e.target.value)}
              >
                <option value="">Choose…</option>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {name(a)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || gone === "" || into === "" || gone === into}
              onClick={join}
            >
              {busy ? "Joining…" : "Join"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setJoining(false);
                setGone("");
                setInto("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
