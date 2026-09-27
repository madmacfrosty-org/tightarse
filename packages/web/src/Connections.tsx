import { useEffect, useState } from "react";
import { AccountsResponse, pathFor, type ConsentView } from "@tightarse/api-contract";
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

/** Ordered by urgency rather than by name: the one that needs attention first. */
const ORDER: ConsentView["health"][] = ["expired", "stale", "escalate", "warn", "ok"];

export function Connections({ api }: { api: Api }) {
  const [consents, setConsents] = useState<ConsentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get(AccountsResponse, pathFor("/accounts"))
      .then((a) => setConsents(a.consents ?? []))
      .catch(() => setError("Could not read the connections"));
  }, [api]);

  if (error) return <div className="card"><h2>Connections</h2><p className="note">{error}</p></div>;

  return (
    <div className="card">
      <h2>Connections</h2>
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
        Renewing and removing a connection are not built yet. A connection that
        is not reporting in has nothing syncing it — usually one replaced by a
        later authorisation of the same bank, which nothing clears.
      </p>
    </div>
  );
}
