import { Consent } from "./consent.js";
import type { Row } from "../ports/outbound/index.js";

/**
 * Stopping tracking a connection that has stopped working.
 *
 * Marked, never deleted. The row is the only record that this consent existed
 * and when it was granted, and a connection going quiet is not a reason to
 * throw that away — the same argument that retires a category rather than
 * dropping it. A removed consent is not shown and not reported on; it is still
 * there.
 *
 * Nothing is asked of the provider. A connection reaches this state precisely
 * because nothing is syncing it, so there is no access token to call with and
 * nothing at the bank still granted. Disconnecting a **live** bank is a
 * different act, needs the provider, and is deliberately not this.
 */

/**
 * Suspending works on any connection, healthy ones included.
 *
 * It used to refuse anything still feeding the ledger, on the grounds that
 * "getting it back means re-authorising". That is an argument about deleting
 * the credential, and deleting is now a separate second act. Suspending only
 * stops the sync and is undone by resuming, so the guard belonged there
 * rather than here.
 *
 * It has to work on a healthy connection. Reconnecting a bank leaves the old
 * connection live and duplicating the new one, and nobody should have to wait
 * ninety days for it to lapse before they can stop it syncing.
 */

export interface RemoveConnectionDeps extends SuspendConnectionDeps {
  /**
   * Delete the stored credential, returning how many there were.
   *
   * Separate from suspending because it cannot be undone from here. What it
   * costs is a trip through the bank to connect again; what it does not cost
   * is history — the ledger and the raw zone keep everything the connection
   * ever fetched, and the consent row stays as the record that it existed.
   */
  readonly deleteConnection: (tenantId: string, credentialsId: string) => Promise<number>;
}

/** Refused because the household has not suspended it first. */
export class ConnectionNotSuspended extends Error {
  readonly statusCode = 409;
  constructor() {
    super(
      "Suspend this connection before removing it. Suspending is reversible; removing is not.",
    );
  }
}

export interface SuspendConnectionDeps {
  readonly listConsents: (tenantId: string) => Promise<Row[]>;
  readonly putConsent: (consent: Consent) => Promise<void>;
  /**
   * Mark the connection itself, which is what the sync reads.
   *
   * The consent row is what the dashboard shows; the connection secret is
   * what the sync lists. Writing only the first is what made the old Remove
   * button hide a connection while it went on syncing every morning —
   * spending the provider allowance and reporting the same problem for ever.
   */
  readonly setConnectionSuspended: (
    tenantId: string,
    credentialsId: string,
    suspended: boolean,
  ) => Promise<void>;
}

export class ConnectionNotFound extends Error {
  readonly statusCode = 404;
  constructor() {
    super("No such connection");
  }
}

/**
 * Stop syncing a connection, reversibly.
 *
 * Two writes, and the order matters. The connection is marked first, because
 * that is what the sync reads: if the second write fails, the household has a
 * connection that has stopped syncing and a row that still says otherwise —
 * which is visible and recoverable. The other order leaves a row claiming it
 * is suspended while the sync carries on, which is the state nobody can see.
 */
export async function suspendConnection(
  deps: SuspendConnectionDeps,
  tenantId: string,
  consentId: string,
  now: Date = new Date(),
): Promise<{ consentId: string; suspendedAt: string }> {
  const consent = await findConsent(deps, tenantId, consentId);

  // Already suspended is not an error. Two tabs and a double press should
  // arrive at the same state rather than report a failure for reaching it.
  if (consent.suspendedAt !== undefined) {
    return { consentId, suspendedAt: consent.suspendedAt };
  }

  const suspendedAt = now.toISOString();
  await deps.setConnectionSuspended(tenantId, consentId, true);
  await deps.putConsent({ ...consent, suspendedAt });
  return { consentId, suspendedAt };
}

/** Start syncing it again. The exact inverse, and the reason suspending is safe. */
export async function resumeConnection(
  deps: SuspendConnectionDeps,
  tenantId: string,
  consentId: string,
): Promise<{ consentId: string }> {
  const consent = await findConsent(deps, tenantId, consentId);
  if (consent.suspendedAt === undefined) return { consentId };

  // The row first here, mirroring suspend: whichever write lands alone should
  // leave the sync doing less than the dashboard claims, never more.
  const { suspendedAt: _was, ...resumed } = consent;
  await deps.putConsent(resumed);
  await deps.setConnectionSuspended(tenantId, consentId, false);
  return { consentId };
}

/**
 * The consent a household names, or a 404.
 *
 * Tolerates a row that does not parse: a scan returns whatever is stored, and
 * one malformed row must not stop a household acting on a different
 * connection.
 */
async function findConsent(
  deps: Pick<SuspendConnectionDeps, "listConsents">,
  tenantId: string,
  consentId: string,
): Promise<Consent> {
  const rows = await deps.listConsents(tenantId);
  const consent = rows
    .map((r) => Consent.safeParse(r))
    .flatMap((p) => (p.success ? [p.data] : []))
    .find((c) => c.consentId === consentId);
  if (consent === undefined) throw new ConnectionNotFound();
  return consent;
}

/**
 * Delete a suspended connection's stored credential.
 *
 * The second of two deliberate acts, and the only irreversible one. It
 * refuses anything the household has not suspended first — not as a dialog
 * asking whether they are sure, but as a fact about the connection: a
 * suspended one has already stopped syncing, so nothing is lost by the time
 * this runs, and somebody who has not suspended it has not yet decided.
 *
 * The consent row is kept and marked. It is the only record that this
 * connection existed and when, and every transaction it produced stays in the
 * ledger — the thing being deleted is a key to a door, not the room.
 *
 * Nothing is asked of the provider. TrueLayer's own delete needs an access
 * token, which needs a live consent, so it is unavailable for exactly the
 * connections worth removing; and the household's consent at the bank lapses
 * on its own schedule regardless of what we hold. Removing is us letting go
 * of a credential, not revoking anything.
 */
export async function removeConnection(
  deps: RemoveConnectionDeps,
  tenantId: string,
  consentId: string,
  now: Date = new Date(),
): Promise<{ consentId: string; removedAt: string; credentialsDeleted: number }> {
  const consent = await findConsent(deps, tenantId, consentId);

  // Already removed is not an error, and must not delete twice or move the
  // date: two tabs and a double press should arrive at the same state.
  if (consent.removedAt !== undefined) {
    return { consentId, removedAt: consent.removedAt, credentialsDeleted: 0 };
  }

  if (consent.suspendedAt === undefined) throw new ConnectionNotSuspended();

  // The credential first. If the row write fails after it, the household has
  // a connection that cannot sync and a row that still lists it — visible,
  // and fixable by pressing the button again. The other order leaves a row
  // saying "removed" over a credential still sitting in Secrets Manager.
  const credentialsDeleted = await deps.deleteConnection(tenantId, consentId);

  const removedAt = now.toISOString();
  await deps.putConsent({ ...consent, removedAt });
  return { consentId, removedAt, credentialsDeleted };
}
