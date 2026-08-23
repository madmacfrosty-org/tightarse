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
 */
export const CONSENT_DAYS = 90;

export function consentExpiry(from = new Date()): string {
  return new Date(from.getTime() + CONSENT_DAYS * 864e5).toISOString();
}

/** Days until a consent lapses; negative once it has. */
export function daysUntilExpiry(connection: Connection, now = new Date()): number {
  return Math.floor((Date.parse(connection.consentExpiresAt) - now.getTime()) / 864e5);
}
