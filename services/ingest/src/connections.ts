import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ListSecretsCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import type { TokenSet } from "@tightarse/truelayer";

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
  constructor(
    private readonly prefix: string,
    private readonly client = new SecretsManagerClient({}),
  ) {}

  private name(tenantId: string, connectionId: string): string {
    return `${this.prefix}/${tenantId}/${connectionId}`;
  }

  async create(connection: Connection): Promise<void> {
    await this.client.send(
      new CreateSecretCommand({
        Name: this.name(connection.tenantId, connection.connectionId),
        SecretString: JSON.stringify(connection),
        Description: `TrueLayer connection for ${connection.tenantId}`,
        Tags: [{ Key: "tenant", Value: connection.tenantId }],
      }),
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
    await this.client.send(
      new PutSecretValueCommand({
        SecretId: this.name(connection.tenantId, connection.connectionId),
        SecretString: JSON.stringify(connection),
      }),
    );
  }

  async get(tenantId: string, connectionId: string): Promise<Connection | null> {
    try {
      const res = await this.client.send(
        new GetSecretValueCommand({ SecretId: this.name(tenantId, connectionId) }),
      );
      return res.SecretString ? (JSON.parse(res.SecretString) as Connection) : null;
    } catch {
      return null;
    }
  }

  /** Every connection for a household. */
  async list(tenantId: string): Promise<Connection[]> {
    const out: Connection[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListSecretsCommand({
          Filters: [{ Key: "name", Values: [`${this.prefix}/${tenantId}/`] }],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const s of res.SecretList ?? []) {
        if (!s.Name) continue;
        const value = await this.client.send(new GetSecretValueCommand({ SecretId: s.Name }));
        if (value.SecretString) out.push(JSON.parse(value.SecretString) as Connection);
      }
      token = res.NextToken;
    } while (token);
    return out;
  }

  /**
   * Remove a connection. Used for erasure and for revoking a superseded
   * consent — leaving a stale one live at the bank for 90 days is the failure
   * mode this exists to prevent.
   */
  async delete(tenantId: string, connectionId: string): Promise<void> {
    await this.client.send(
      new DeleteSecretCommand({
        SecretId: this.name(tenantId, connectionId),
        ForceDeleteWithoutRecovery: true,
      }),
    );
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
