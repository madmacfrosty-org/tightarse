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
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Secrets } from "@tightarse/ports";

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

  async set(name: string, value: string): Promise<void> {
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
      await this.client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    }
  }
}
