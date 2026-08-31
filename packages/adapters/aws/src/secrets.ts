/**
 * Secrets Manager.
 *
 * The adapter for `Secrets`. Create-or-update is one method here because the
 * distinction is the store's problem: callers storing a refreshed token do not
 * know or care whether this connection has been stored before.
 */

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  TagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
import type { Secrets } from "@tightarse/domain";

export interface AwsSecretsOptions {
  readonly client?: SecretsManagerClient;
  readonly region?: string;
}

export class AwsSecrets implements Secrets {
  private readonly client: SecretsManagerClient;

  constructor(opts: AwsSecretsOptions = {}) {
    this.client = opts.client ?? new SecretsManagerClient(opts.region ? { region: opts.region } : {});
  }

  /** Undefined when absent, rather than throwing — a connection with no stored
   *  token yet is an ordinary state during the connect flow. */
  async get(name: string): Promise<string | undefined> {
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return res.SecretString;
    } catch (err) {
      if ((err as { name?: string }).name === "ResourceNotFoundException") return undefined;
      throw err;
    }
  }

  async set(
    name: string,
    value: string,
    opts: { description?: string; tags?: Record<string, string> } = {},
  ): Promise<void> {
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      // Tags on an existing secret are applied separately; PutSecretValue does
      // not carry them. Silently dropping them would leave a secret findable by
      // nobody.
      if (opts.tags) await this.tag(name, opts.tags);
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
      await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: value,
          ...(opts.description ? { Description: opts.description } : {}),
          ...(opts.tags
            ? { Tags: Object.entries(opts.tags).map(([Key, Value]) => ({ Key, Value })) }
            : {}),
        }),
      );
    }
  }

  private async tag(name: string, tags: Record<string, string>): Promise<void> {
    await this.client.send(
      new TagResourceCommand({
        SecretId: name,
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
  }

  /**
   * Names under a prefix, following pagination.
   *
   * The filter is server-side, so a household with one connection does not pay
   * for listing every secret in the account.
   */
  async list(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListSecretsCommand({
          Filters: [{ Key: "name", Values: [prefix] }],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const s of res.SecretList ?? []) if (s.Name) names.push(s.Name);
      token = res.NextToken;
    } while (token);
    return names;
  }
}
