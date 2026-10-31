import { useCallback, useEffect, useState } from "react";
import {
  AccountsResponse,
  pathFor,
  RemoveConnectionResponse,
  SuspendConnectionResponse,
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
/** What a row can be doing. Each button reports its own, and no other. */
type Action = "suspend" | "resume" | "remove";

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
  /**
   * Which connection is working, and at what.
   *
   * The action, not only the connection. It used to be the consent id alone,
   * and both buttons on a row asked the same question — so pressing Remove
   * made the button beside it say "Resuming…", which is the wrong control
   * reporting the wrong thing about an action that deletes a credential.
   */
  const [busy, setBusy] = useState<{ consentId: string; action: Action } | null>(null);
  const working = (consentId: string, action: Action) =>
    busy?.consentId === consentId && busy.action === action;





  /**
   * Stop or start syncing one connection.
   *
   * Offered on any connection, healthy ones included. The old button refused
   * anything still feeding the ledger, on the grounds that getting it back
   * meant re-authorising — but that is an argument about deleting the stored
   * credential, which this does not do. Reconnecting a bank leaves the old
   * connection live and duplicating the new one, and nobody should wait
   * ninety days for it to lapse before they can stop it syncing.
   */
  const setSuspended = async (consentId: string, suspended: boolean) => {
    setBusy({ consentId, action: suspended ? "suspend" : "resume" });
    setActionError(null);
    try {
      await api.post(SuspendConnectionResponse, pathFor("/connections/suspend"), {
        consentId,
        suspended,
      });
      // Re-read rather than patch the row. Suspending changes what the sync
      // will do, and the server is what knows it — a row edited here would be
      // this page agreeing with itself.
      await read();
    } catch (e: unknown) {
      setActionError(
        e instanceof Error
          ? e.message
          : `Could not ${suspended ? "suspend" : "resume"} that connection`,
      );
    } finally {
      setBusy(null);
    }
  };

  /**
   * Delete the stored credential for a suspended connection.
   *
   * Offered only once suspended, which is the guard: suspending has already
   * stopped it syncing, so nothing is lost by the time this is pressed but
   * the key itself. Getting it back means connecting at the bank again.
   *
   * Confirmed rather than merely offered. Remove deliberately had no dialog
   * when it only hid a row — "a dialog asking are you sure about something
   * already dead teaches people to click through dialogs" — but this one
   * cannot be undone, which is exactly when asking is worth it.
   */
  const remove = async (c: ConsentView) => {
    const bank = c.institutionName ?? "this connection";
    if (
      !window.confirm(
        `Delete the stored credential for ${bank}?\n\n` +
          "Its transactions are kept. Connecting it again means a trip through the bank.",
      )
    ) {
      return;
    }

    setBusy({ consentId: c.consentId, action: "remove" });
    setActionError(null);
    try {
      await api.post(RemoveConnectionResponse, pathFor("/connections/remove"), {
        consentId: c.consentId,
      });
      await read();
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
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy !== null}
                      onClick={() => void setSuspended(c.consentId, c.suspendedAt === undefined)}
                      title={
                        c.suspendedAt === undefined
                          ? "Stop the daily sync touching this connection. Nothing is deleted and it can be resumed."
                          : "Start syncing this connection again."
                      }
                    >
                      {c.suspendedAt === undefined
                        ? working(c.consentId, "suspend")
                          ? "Suspending…"
                          : "Suspend"
                        : working(c.consentId, "resume")
                          ? "Resuming…"
                          : "Resume"}
                    </button>
                    {c.suspendedAt !== undefined && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== null}
                        onClick={() => void remove(c)}
                        title="Delete the stored credential. Transactions are kept; reconnecting means a trip through the bank."
                      >
                        {working(c.consentId, "remove") ? "Removing…" : "Remove"}
                      </button>
                    )}
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
