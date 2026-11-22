import { describe, it, expect, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoAccounts } from "../src/accounts.js";

/**
 * What `markSuperseded` does when the write is refused.
 *
 * The condition on it is load-bearing: it is what makes a daily job safe to
 * re-run, and it is the only thing stopping a later sync repointing an account
 * at a different successor. So both outcomes matter — a refusal because the
 * link is already there has to be silent, and anything else has to be loud.
 *
 * Swallowing the wrong one would be the bad kind of quiet. A throttle, an
 * expired credential or a missing table would all look like "already
 * reconciled", the job would report success, and nothing would ever be
 * recorded.
 */

const adapter = (send: () => Promise<unknown>) =>
  new DynamoAccounts({
    tableName: "t",
    client: { send } as unknown as DynamoDBDocumentClient,
  });

const named = (name: string): Error => Object.assign(new Error(name), { name });

describe("recording that an account was superseded", () => {
  it("treats a refused condition as already recorded, not as a failure", async () => {
    const send = vi.fn(async () => {
      throw named("ConditionalCheckFailedException");
    });

    await expect(
      adapter(send).markSuperseded("frost", "old", "new", "2026-11-01T00:00:00.000Z", { shared: 86 }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets every other failure through", async () => {
    // A throttle is not a link that already exists, and a job that reports
    // success here would leave the household's figures wrong indefinitely.
    const send = vi.fn(async () => {
      throw named("ProvisionedThroughputExceededException");
    });

    await expect(
      adapter(send).markSuperseded("frost", "old", "new", "2026-11-01T00:00:00.000Z", { shared: 86 }),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  it("lets an error carrying no name through", async () => {
    // Nothing about a bare throw says "already recorded".
    const send = vi.fn(async () => {
      throw "a bare string";
    });

    await expect(
      adapter(send).markSuperseded("frost", "old", "new", "2026-11-01T00:00:00.000Z", { shared: 86 }),
    ).rejects.toBe("a bare string");
  });

  it("writes the identity fields alongside the link", async () => {
    // So the row is readable even when the update is what created it. A row
    // with a link and no account id reads as an account with no id, and two of
    // those look like one account.
    const sent: Record<string, unknown>[] = [];
    const send = vi.fn(async (cmd: { input: Record<string, unknown> }) => {
      sent.push(cmd.input);
      return {};
    });

    await adapter(send as unknown as () => Promise<unknown>).markSuperseded(
      "frost",
      "old",
      "new",
      "2026-11-01T00:00:00.000Z",
      { shared: 86 },
    );

    const values = sent[0]?.["ExpressionAttributeValues"] as Record<string, unknown>;
    expect(values).toMatchObject({
      ":accountId": "old",
      ":tenantId": "frost",
      ":kind": "ACCOUNT",
      ":supersededBy": "new",
      ":reconciledAt": "2026-11-01T00:00:00.000Z",
    });
    expect(sent[0]?.["ConditionExpression"]).toBe("attribute_not_exists(#supersededBy)");
  });
});
