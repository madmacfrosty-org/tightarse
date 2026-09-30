import { useCallback, useEffect, useState } from "react";
import { loadConfig } from "./config";
import {
  AccountsResponse,
  pathFor,
  RemoveConnectionResponse,
  ReconfirmConnectionResponse,
  type ConsentView,
} from "@tightarse/api-contract";
import type { Api } from "./ports";

/**
 * Every bank connection, and how long each has left.
 *
 * The urgent path already works: a consent close to lapsing announces itself on
 * `/`, above the figures, because it has a deadline and the numbers do not.
 * This is the routine path — somewhere to look when you simply want to know,
 * rather than being told because it has become a problem.
 *
 * It reports what the provider said **and when we last asked**, which are two
 * facts rather than one. "Authorised" seven weeks ago and "Authorised" this
 * morning are different claims, and the model already knows the difference:
 * `consentHealth` returns `stale` for a consent nothing has heard about
 * recently. A page that showed only the status would make a connection nothing
 * syncs look exactly like one that syncs every morning.
 */

const WORDS: Record<ConsentView["health"], string> = {
  ok: "Healthy",
  warn: "Expiring soon",
  escalate: "Expiring — act now",
  expired: "Lapsed",
  stale: "Not reporting in",
};

/**
 * When the provider was last asked about any of this.
 *
 * The most recent of them, because the sync asks about every connection in one
 * run — so the newest answer is when the run last succeeded. A connection that
 * is older than this has stopped being asked about, which is what its own row
 * says.
 *
 * A time rather than a duration. Every healthy connection would read "0 days
 * ago" every day, which says nothing; "at 06:00" tells you whether this morning
 * happened.
 */
function lastRefreshed(consents: ConsentView[]): string | null {
  const newest = consents
    .map((c) => Date.parse(c.fetchedAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (newest === undefined) return null;
  return new Date(newest).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * What may be stopped, and what may not.
 *
 * Only a connection nothing is syncing. One still feeding the ledger is not
 * offered rather than confirmed: the guard is a fact about the connection
 * instead of a question about intent, and a dialog asking "are you sure" about
 * something already dead teaches people to click through dialogs.
 *
 * Disconnecting a live bank is a different act — it needs the provider, and
 * getting back means re-authorising, which is the flow with the history window.
 */
const REMOVABLE: ConsentView["health"][] = ["stale", "expired"];

/**
 * Which connections can be renewed: the ones that have not gone yet.
 *
 * The exact complement of REMOVABLE, and deliberately so — every connection
 * gets one action, decided by its state rather than by what the household
 * feels like doing. A lapsed consent cannot be extended: there is nothing
 * left to extend, and the remedy is connecting again, which costs a trip
 * through the bank.
 */
const RENEWABLE: ConsentView["health"][] = ["ok", "warn", "escalate"];

/** Ordered by urgency rather than by name: the one that needs attention first. */
const ORDER: ConsentView["health"][] = ["expired", "stale", "escalate", "warn", "ok"];

export function Connections({ api }: { api: Api }) {
  const [consents, setConsents] = useState<ConsentView[] | null>(null);
  // Two errors, because they mean different things. Failing to read means
  // there is no list to show; failing to remove means the list is still true
  // and one action did not happen. Collapsing them made a refused removal
  // replace the table, which tells the household the connection went — the
  // opposite of what happened.
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * Whether this deployment may renew at all.
   *
   * Asked of the deployment rather than worked out here. The API refuses
   * regardless — a control that is not rendered is not a control that cannot
   * be called — so this only keeps the page from offering something that
   * cannot work.
   */
  const [mayRenew, setMayRenew] = useState(false);

  useEffect(() => {
    loadConfig()
      .then((cfg) => setMayRenew(cfg.canRenewConnections === true))
      // A failed read leaves the control hidden, which is the safe way round:
      // the API would refuse anyway, and an offered action that cannot work is
      // worse than one that is absent.
      .catch(() => setMayRenew(false));
  }, []);

  const remove = async (consentId: string) => {
    setBusy(consentId);
    setActionError(null);
    try {
      await api.post(RemoveConnectionResponse, pathFor("/connections/remove"), {
        consentId,
      });
      // Dropped from the list rather than re-read. The row is still there —
      // it is the only record the connection existed — and the list is what
      // stops showing it.
      setConsents((c) => (c ?? []).filter((x) => x.consentId !== consentId));
    } catch (e: unknown) {
      setActionError(
        e instanceof Error ? e.message : "Could not remove that connection",
      );
    } finally {
      setBusy(null);
    }
  };

  const read = useCallback(
    () =>
      api
        .get(AccountsResponse, pathFor("/accounts"))
        .then((a) => setConsents(a.consents ?? []))
        .catch(() => setReadError("Could not read the connections")),
    [api],
  );

  useEffect(() => {
    void read();
  }, [read]);

  const reconfirm = async (consentId: string) => {
    setBusy(consentId);
    setActionError(null);
    try {
      const out = await api.post(
        ReconfirmConnectionResponse,
        pathFor("/connections/reconfirm"),
        { consentId },
      );
      if (out.action !== "renewed" && out.continueAt !== undefined) {
        // The provider wants a person. Leave rather than report success: the
        // consent is not renewed until they finish, and saying otherwise here
        // would be a lie the page could not take back.
        window.location.assign(out.continueAt);
        return;
      }
      // Re-read rather than patch the row. The new expiry is the provider's
      // answer and the server has it; computing one here would show a date
      // nothing agrees with.
      await read();
    } catch (e: unknown) {
      setActionError(
        e instanceof Error ? e.message : "Could not renew that connection",
      );
    } finally {
      setBusy(null);
    }
  };

  if (readError) {
    return (
      <div className="card">
        <h2>Connections</h2>
        <p className="note">{readError}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Connections</h2>
      {actionError !== null && (
        <p className="note" role="alert">
          {actionError}
        </p>
      )}
      {consents === null && <p className="note">Reading…</p>}
      {consents !== null && consents.length === 0 && (
        <p className="note">No bank is connected yet.</p>
      )}
      {consents !== null && consents.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Bank</th>
              <th>Consent</th>
              <th>Provider said</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...consents]
              .sort((a, b) => ORDER.indexOf(a.health) - ORDER.indexOf(b.health))
              .map((c) => (
                <tr key={c.consentId}>
                  <td>{c.institutionName ?? "Unknown bank"}</td>
                  <td>
                    {/* Days rather than a date. "Forty" is a decision; the
                        eleventh of November is arithmetic somebody has to do. */}
                    {c.daysRemaining > 0
                      ? `${c.daysRemaining} days left`
                      : "Lapsed"}
                    {" · "}
                    <span className="subtle">{WORDS[c.health]}</span>
                  </td>
                  <td className="subtle">{c.providerStatus ?? "—"}</td>
                  <td>
                    {mayRenew && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={!RENEWABLE.includes(c.health) || busy !== null}
                        onClick={() => void reconfirm(c.consentId)}
                        title={
                          RENEWABLE.includes(c.health)
                            ? "Confirm with the provider that this connection may continue"
                            : "Already lapsed — connect the bank again rather than renewing"
                        }
                      >
                        {busy === c.consentId ? "Renewing…" : "Reconfirm"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost"
                      disabled={!REMOVABLE.includes(c.health) || busy !== null}
                      onClick={() => void remove(c.consentId)}
                      // Says why it is unavailable rather than leaving a dead
                      // control. A greyed button with no reason is a puzzle.
                      title={
                        REMOVABLE.includes(c.health)
                          ? "Stop tracking this connection. Transactions are kept."
                          : "Still working — only a connection that has stopped can be removed"
                      }
                    >
                      {busy === c.consentId ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      {consents !== null && consents.length > 0 && (
        <p className="note">
          Connection data was last refreshed at {lastRefreshed(consents)}. It is
          asked for once a day; nothing retrieves it on demand.
        </p>
      )}
      <p className="note">
        Removing stops a connection being listed and reported on. Its
        transactions are kept, and so is the record that it existed. Only a
        connection that has stopped reporting in can be removed — usually one
        replaced by a later authorisation of the same bank. Renewing is not
        built yet.
      </p>
    </div>
  );
}
