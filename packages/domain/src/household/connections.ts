import { Consent, consentHealth, type ConsentHealth } from "./consent.js";
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

/** What this can act on. Anything still feeding the ledger is refused. */
export const REMOVABLE: readonly ConsentHealth[] = ["stale", "expired"];

export interface RemoveConnectionDeps {
  readonly listConsents: (tenantId: string) => Promise<Row[]>;
  readonly putConsent: (consent: Consent) => Promise<void>;
  readonly getSettings: (
    tenantId: string,
  ) => Promise<{ consentWarnDays?: number; consentEscalateDays?: number } | null>;
}

export class ConnectionNotRemovable extends Error {
  readonly statusCode = 409;
  constructor(readonly health: ConsentHealth) {
    // Says which state it is in, because "cannot remove this" without the
    // reason is a dead end for whoever hit it.
    super(`A connection that is ${health} is still working; disconnect it instead`);
  }
}

export class ConnectionNotFound extends Error {
  readonly statusCode = 404;
  constructor() {
    super("No such connection");
  }
}

/**
 * Mark one connection removed.
 *
 * Refuses a live one rather than asking whether you are sure. The guard is a
 * fact about the connection instead of a question about intent, which is the
 * stronger of the two — a dialog trains people to click through dialogs.
 */
export async function removeConnection(
  deps: RemoveConnectionDeps,
  tenantId: string,
  consentId: string,
  // Defaulted so the composition root can bind this against the store rather
  // than wrap it — a wrapper there is a line no test can reach without a
  // table. A test passes the moment it means.
  now: Date = new Date(),
): Promise<{ consentId: string; removedAt: string }> {
  const settings = await deps.getSettings(tenantId);
  const rows = await deps.listConsents(tenantId);
  const consent = rows
    .map((r) => Consent.safeParse(r))
    .flatMap((p) => (p.success ? [p.data] : []))
    .find((c) => c.consentId === consentId);

  if (consent === undefined) throw new ConnectionNotFound();

  // Already removed is not an error. Pressing twice, or two tabs, should leave
  // the same state rather than report a failure for arriving at it.
  if (consent.removedAt !== undefined) {
    return { consentId, removedAt: consent.removedAt };
  }

  const { health } = consentHealth(consent, {
    now,
    warnDays: settings?.consentWarnDays ?? 30,
    escalateDays: settings?.consentEscalateDays ?? 10,
  });
  if (!REMOVABLE.includes(health)) throw new ConnectionNotRemovable(health);

  const removedAt = now.toISOString();
  await deps.putConsent({ ...consent, removedAt });
  return { consentId, removedAt };
}
