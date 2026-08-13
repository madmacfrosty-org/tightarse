import { describe, it, expect, vi } from "vitest";
import { TrueLayerError } from "@tightarse/truelayer";
import {
  listConnections,
  refreshAndList,
  fetchItem,
  recordOutcome,
  type StepDeps,
} from "./steps.js";
import type { Connection } from "./connections.js";

/**
 * These tests exist because of the dependency injection refactor. Before it,
 * this file built its own AWS clients when the module loaded and nothing here
 * could be exercised at all.
 */

const connection = (over: Partial<Connection> = {}): Connection => ({
  connectionId: "conn-1",
  tenantId: "frost",
  provider: "truelayer",
  refreshToken: "refresh-old",
  consentExpiresAt: "2026-12-01T00:00:00.000Z",
  connectedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

interface Fakes {
  deps: StepDeps;
  gets: string[];
  puts: Array<Record<string, unknown>>;
  updated: Connection[];
  published: string[];
}

/** Records what was asked of the outside world, and answers plausibly. */
function fakes(
  responses: (path: string) => unknown | Promise<unknown> = () => ({ results: [] }),
): Fakes {
  const gets: string[] = [];
  const puts: Array<Record<string, unknown>> = [];
  const updated: Connection[] = [];
  const published: string[] = [];

  const deps = {
    tenantId: "frost",
    rawBucket: "raw-bucket",
    environment: "live",
    alertTopicArn: "arn:aws:sns:eu-west-1:1:alerts",
    truelayer: {
      refresh: vi.fn(async () => ({ accessToken: "access-new", refreshToken: "refresh-new" })),
      get: vi.fn(async (_token: string, path: string) => {
        gets.push(path);
        return { body: await responses(path) };
      }),
    },
    connections: {
      list: vi.fn(async () => [connection(), connection({ connectionId: "conn-2" })]),
      update: vi.fn(async (c: Connection) => {
        updated.push(c);
      }),
    },
    s3: { send: vi.fn(async (cmd: { input: Record<string, unknown> }) => puts.push(cmd.input)) },
    sns: { send: vi.fn(async (cmd: { input: { Message?: string } }) => published.push(cmd.input.Message ?? "")) },
  } as unknown as StepDeps;

  return { deps, gets, puts, updated, published };
}

describe("listConnections", () => {
  it("returns every connection for the household by default", async () => {
    const { deps } = fakes();
    expect((await listConnections(deps, {})).connections).toHaveLength(2);
  });

  it("returns only the one a connect just made", async () => {
    // Adding a card must not spend the others' four-calls-per-24-hours.
    const { deps } = fakes();
    const out = await listConnections(deps, { input: { connectionId: "conn-2" } });
    expect(out.connections.map((c) => c.connectionId)).toEqual(["conn-2"]);
  });
});

describe("refreshAndList", () => {
  it("persists a rotated refresh token before doing anything else", async () => {
    // A rotated token that is not saved kills the connection on the next run.
    const { deps, updated } = fakes();
    await refreshAndList(deps, { connection: connection() });
    expect(updated[0]?.refreshToken).toBe("refresh-new");
  });

  it("reports a lapsed consent instead of throwing", async () => {
    // Only a human reconnecting at the bank can fix it, so a thrown error
    // would be retried by the state machine for no purpose.
    const { deps } = fakes();
    (deps.truelayer.refresh as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TrueLayerError("consent expired", 400, "invalid_grant"),
    );
    const out = await refreshAndList(deps, { connection: connection() });
    expect(out.consentExpired).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("skips a resource the provider does not offer", async () => {
    // Amex is cards-only and has no accounts scope at all. A missing resource
    // is a shape, not a failure.
    const { deps } = fakes((path) => {
      if (path.endsWith("/accounts")) throw new TrueLayerError("not offered", 403, "forbidden");
      return { results: [{ account_id: "card-1" }] };
    });
    const out = await refreshAndList(deps, { connection: connection() });
    expect(out.skipped).toContain("accounts");
    expect(out.items).toEqual([{ resource: "cards", itemId: "card-1" }]);
  });

  it("lands the account and card lists it fetched", async () => {
    const { deps, puts } = fakes(() => ({ results: [{ account_id: "a1" }] }));
    await refreshAndList(deps, { connection: connection() });
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((p) => p["Bucket"] === "raw-bucket")).toBe(true);
  });
});

describe("fetchItem", () => {
  const input = {
    tenantId: "frost",
    accessToken: "access",
    resource: "accounts" as const,
    itemId: "acc-1",
  };

  it("asks for transactions first, over the full history window", async () => {
    const { deps, gets } = fakes();
    await fetchItem(deps, input);
    expect(gets[0]).toContain("/accounts/acc-1/transactions?from=");
  });

  it("never asks a card for direct debits or standing orders", async () => {
    // They are account concepts. The card paths return 404, which failed the
    // whole step, retried four times, and re-fetched transactions, detail and
    // balance on every attempt — five times the necessary calls against a cap
    // of four per 24 hours.
    const { deps, gets } = fakes();
    await fetchItem(deps, { ...input, resource: "cards", itemId: "card-1" });
    expect(gets.some((g) => g.includes("direct_debits"))).toBe(false);
    expect(gets.some((g) => g.includes("standing_orders"))).toBe(false);
  });

  it("does ask an account for them", async () => {
    const { deps, gets } = fakes();
    await fetchItem(deps, input);
    expect(gets.some((g) => g.includes("direct_debits"))).toBe(true);
    expect(gets.some((g) => g.includes("standing_orders"))).toBe(true);
  });

  it("skips an optional endpoint the provider refuses, rather than failing", async () => {
    // First Direct returns 501 for standing orders everywhere and 403 for
    // direct debits on accounts that have none.
    const { deps } = fakes((path) => {
      if (path.includes("standing_orders")) throw new TrueLayerError("not implemented", 501, "not_implemented");
      if (path.includes("direct_debits")) throw new TrueLayerError("not offered", 403, "forbidden");
      return { results: [] };
    });
    const out = await fetchItem(deps, input);
    expect(out.skipped).toHaveLength(2);
    expect(out.objects).toBeGreaterThan(0);
  });

  it("still fails on a genuine error, so the state machine retries it", async () => {
    const { deps } = fakes((path) => {
      if (path.includes("/transactions?")) throw new TrueLayerError("boom", 500, "server_error");
      return { results: [] };
    });
    await expect(fetchItem(deps, input)).rejects.toThrow();
  });
});

describe("recordOutcome", () => {
  it("records a sync even when some items failed", async () => {
    const { deps, updated } = fakes();
    const out = await recordOutcome(deps, {
      connection: connection(),
      results: [{ objects: 3 }, { Error: "States.TaskFailed", Cause: "boom" }],
    });
    expect(updated[0]?.lastSyncedAt).toBeDefined();
    expect(out.problems.some((p) => p.includes("States.TaskFailed"))).toBe(true);
  });

  it("does not mark a lapsed consent as synced", async () => {
    const { deps, updated } = fakes();
    const out = await recordOutcome(deps, { connection: connection(), consentExpired: true });
    expect(updated).toHaveLength(0);
    expect(out.problems[0]).toContain("expired");
  });

  it("warns before a consent lapses, not on the day", async () => {
    // Reconfirmation needs a person at a browser.
    const { deps } = fakes();
    const out = await recordOutcome(deps, {
      connection: connection(),
      daysUntilConsentExpiry: 7,
      results: [],
    });
    expect(out.problems.some((p) => p.includes("7 day"))).toBe(true);
  });

  it("stays quiet when there is nothing to report", async () => {
    const { deps, published } = fakes();
    const out = await recordOutcome(deps, {
      connection: connection(),
      daysUntilConsentExpiry: 60,
      results: [{ objects: 4 }],
    });
    expect(out.problems).toEqual([]);
    expect(published).toEqual([]);
  });

  it("publishes problems to the alert topic", async () => {
    const { deps, published } = fakes();
    await recordOutcome(deps, { connection: connection(), consentExpired: true });
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("expired");
  });

  it("never puts a transaction body in the log or the alert", async () => {
    // Counts only: CloudWatch is not a place for a merchant name.
    const { deps, published } = fakes();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordOutcome(deps, {
      connection: connection(),
      results: [{ objects: 9, skipped: ["truelayer.standing_orders acc-1"] }],
    });
    const written = log.mock.calls.flat().join(" ") + published.join(" ");
    expect(written).not.toContain("description");
    expect(written).toContain("connectionId");
    log.mockRestore();
  });
});

describe("history window", () => {
  it("asks for five years while the exemption window is open", async () => {
    const { deps, gets } = fakes(() => ({ results: [{ account_id: "a1" }] }));
    const out = await refreshAndList(deps, {
      connection: connection({ connectedAt: new Date().toISOString() }),
    });
    expect(out.historyMonths).toBe(60);

    await fetchItem(deps, {
      tenantId: "frost",
      accessToken: "a",
      resource: "accounts",
      itemId: "a1",
      historyMonths: out.historyMonths,
    });
    const txCall = gets.find((g) => g.includes("/transactions?from="));
    const from = new Date(txCall!.match(/from=([0-9-]+)/)![1]!);
    const years = (Date.now() - from.getTime()) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(4.9);
  });

  it("asks for ninety days once it has closed", async () => {
    // The bug this fixes: every daily sync asked for sixty months, the provider
    // refused the whole call with a 403, and the ledger stopped moving while
    // balances kept updating — so nothing looked wrong.
    const { deps, gets } = fakes(() => ({ results: [{ account_id: "a1" }] }));
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
    const out = await refreshAndList(deps, { connection: connection({ connectedAt: yesterday }) });
    expect(out.historyMonths).toBe(3);

    await fetchItem(deps, {
      tenantId: "frost",
      accessToken: "a",
      resource: "accounts",
      itemId: "a1",
      historyMonths: out.historyMonths,
    });
    const txCall = gets.find((g) => g.includes("/transactions?from="));
    const from = new Date(txCall!.match(/from=([0-9-]+)/)![1]!);
    const days = (Date.now() - from.getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(93);
    expect(days).toBeGreaterThan(85);
  });
});
