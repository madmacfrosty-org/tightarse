import type { Secrets } from "@tightarse/domain";

/**
 * Where a household's bank connections live.
 *
 * One secret per connection under a known prefix, in FoundationStack — a stack
 * that is never destroyed, so wiping the dev data does not cost a trip through
 * the bank's authorisation journey.
 *
 * The refresh token is the whole value here: losing it means re-consenting, and
 * a consent is a one-shot chance at deep history.
 */

export interface Connection {
  connectionId: string;
  tenantId: string;
  provider: "truelayer";
  refreshToken: string;
  /** When the CONSENT lapses — not the access token. Set at connect time. */
  consentExpiresAt: string;
  connectedAt: string;
  lastSyncedAt?: string;
  /**
   * The provider's own id for this consent — `credentials_id` from `/me`.
   *
   * What links a stored connection to the consent row the dashboard shows.
   * Nothing recorded it before renewal needed it: the raw object key carries
   * tenant, dataset and account but no connection, so the transform that
   * writes consent rows genuinely cannot know which connection produced one.
   *
   * Optional because connections made before this existed do not have it.
   * `resolveCredentialsId` fills it in on first use and stores it, which costs
   * one data call once rather than a change to the ingest path — and the
   * ingest path is the one that can cost five years of history.
   */
  credentialsId?: string;
  /**
   * When the household stopped syncing this connection, if it has.
   *
   * Here rather than only on the consent row because this is what the sync
   * lists. The old Remove button wrote the row alone, so a connection it had
   * "removed" went on syncing every morning — spending the provider
   * allowance and reporting the same problem for ever.
   *
   * The refresh token stays. Suspending is undone by resuming, and the token
   * is the one thing whose loss costs history no retry recovers; deleting it
   * is a separate, deliberate second act.
   */
  suspendedAt?: string;
}

export class Connections {
  /**
   * Takes the `Secrets` port rather than a Secrets Manager client.
   *
   * A refresh token is the one secret whose loss costs five years of history that
   * no retry recovers — the only way back is a fresh consent, and a fresh consent
   * only offers 90 days. A class holding the whole SDK client could delete one;
   * this can get, set and list, which is all it does.
   */
  constructor(
    private readonly prefix: string,
    private readonly secrets: Secrets,
  ) {}

  private name(tenantId: string, connectionId: string): string {
    return `${this.prefix}/${tenantId}/${connectionId}`;
  }

  async create(connection: Connection): Promise<void> {
    await this.secrets.set(
      this.name(connection.tenantId, connection.connectionId),
      JSON.stringify(connection),
      {
        description: `TrueLayer connection for ${connection.tenantId}`,
        tags: { tenant: connection.tenantId },
      },
    );
  }

  /**
   * Persist a rotated refresh token.
   *
   * Called after every refresh, unconditionally. TrueLayer may hand back a new
   * refresh token and invalidate the old one, and writing it back is the
   * difference between a connection that keeps working and one that dies
   * quietly a few days later.
   */
  async update(connection: Connection): Promise<void> {
    await this.secrets.set(
      this.name(connection.tenantId, connection.connectionId),
      JSON.stringify(connection),
    );
  }

  /**
   * Stop or restart syncing one connection, found by the provider's own id.
   *
   * Takes `credentialsId` rather than our `connectionId` because that is what
   * a household's dashboard knows a connection by. The link is written by the
   * sync from the `/me` it already fetches.
   */
  async setSuspended(
    tenantId: string,
    credentialsId: string,
    suspendedAt: string | undefined,
  ): Promise<boolean> {
    const all = await this.list(tenantId);
    const found = all.filter((c) => c.credentialsId === credentialsId);
    if (found.length === 0) return false;

    // Every match, not the first. A bank reconnected twice can leave more than
    // one connection carrying the same consent id, and suspending one of them
    // would leave the other syncing — which is the bug this is fixing.
    for (const c of found) {
      const { suspendedAt: _was, ...rest } = c;
      await this.update(suspendedAt === undefined ? rest : { ...rest, suspendedAt });
    }
    return true;
  }

  /**
   * Delete the credentials for one consent, and say how many there were.
   *
   * Only ever called on a connection the household has suspended, which is
   * the guard that makes this safe: a suspended connection is not syncing, so
   * its refresh token is doing nothing, and deleting it costs a trip through
   * the bank rather than any history — the ledger and the raw zone keep
   * everything it ever fetched.
   *
   * Every match, like `setSuspended`: a bank reconnected twice can leave more
   * than one connection on the same consent id, and deleting one of them
   * would leave the other holding a credential nobody can see.
   */
  async deleteForConsent(tenantId: string, credentialsId: string): Promise<number> {
    const all = await this.list(tenantId);
    const found = all.filter((c) => c.credentialsId === credentialsId);
    for (const c of found) {
      await this.secrets.delete(this.name(tenantId, c.connectionId));
    }
    return found.length;
  }

  async get(tenantId: string, connectionId: string): Promise<Connection | null> {
    const value = await this.secrets.get(this.name(tenantId, connectionId));
    return value ? (JSON.parse(value) as Connection) : null;
  }

  /** Every connection for a household. */
  async list(tenantId: string): Promise<Connection[]> {
    // The port pages for us and returns names only, so this fetches exactly the
    // secrets it is going to parse.
    const names = await this.secrets.list(`${this.prefix}/${tenantId}/`);
    const out: Connection[] = [];
    for (const name of names) {
      const value = await this.secrets.get(name);
      if (value) out.push(JSON.parse(value) as Connection);
    }
    return out;
  }

}

/**
 * UK rules require consent to be reconfirmed with the AISP every 90 days, or
 * data access stops. Recorded as an absolute date at connect time so nothing
 * has to recompute it from an issue date it may not have.
 *
 * Reconfirming is not available to us, and this is where to find that out
 * before going looking. TrueLayer exposes it on `/connections/extend`, which
 * refuses our client id with 400: "not permitted to set
 * user_has_reconfirmed_consent to true in this environment. To enable this
 * client_id you must submit your consent screen for review." The review is
 * gated behind a paid plan. Setting the flag false is documented as "currently
 * not supported", so their hosted dialog is not a way round it either.
 *
 * So the only renewal is reconnecting at the bank — a fresh authorisation,
 * a fresh 90 days, and the deep-history window spent. See #69.
 */
export const CONSENT_DAYS = 90;

export function consentExpiry(from = new Date()): string {
  return new Date(from.getTime() + CONSENT_DAYS * 864e5).toISOString();
}

/** Days until a consent lapses; negative once it has. */
export function daysUntilExpiry(connection: Connection, now = new Date()): number {
  return Math.floor((Date.parse(connection.consentExpiresAt) - now.getTime()) / 864e5);
}
