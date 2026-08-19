import { describe, it, expect, vi } from "vitest";
import { TrueLayerError } from "@tightarse/truelayer";
import {
  listConnections,
  refreshAndList,
  fetchItem,
  recordOutcome,
  type StepDeps,
  stepEnvironments,
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

  /**
   * The plain configuration, typed rather than swept up in the cast below.
   *
   * The cast is needed for the fake clients, but it also hid a renamed field:
   * `environment` used to mean two things at once and the compiler could not
   * say so. These four are checked.
   */
  const config: Pick<
    StepDeps,
    "tenantId" | "rawBucket" | "providerEnvironment" | "deploymentEnvironment"
  > = {
    tenantId: "frost",
    rawBucket: "raw-bucket",
    // Deliberately different values, so a test asserting one cannot pass by
    // accidentally reading the other.
    providerEnvironment: "live",
    deploymentEnvironment: "dev",
  };

  const deps = {
    ...config,
    truelayer: {
      // The real client counts data calls; the fake reports what it recorded.
      get calls() {
        return gets.length;
      },
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
    raw: {

      // The port takes a key rather than a Bucket, because which bucket the raw

      // zone lives in is the adapter's business and not the sync's.

      put: vi.fn(async (key: string, _body: Uint8Array, opts?: Record<string, unknown>) =>

        puts.push({ key, ...(opts ?? {}) }),

      ),

      get: vi.fn(async () => new Uint8Array()),

      list: vi.fn(async () => [] as string[]),

    },
    // A Notifications, not an SNS client. The step decides something needs a
    // person; the topic it lands on is the adapter's business.
    notifications: { publish: async (_subject: string, message: string) => void published.push(message) },
  } as unknown as StepDeps;

  return { deps, gets, puts, updated, published };
}

describe("listConnections", () => {
  it("returns every connection for the household by default", async () => {
    const { deps } = fakes();
    expect((await listConnections(deps, {})).connections).toHaveLength(2);
  });

  it("returns only the one a connect just made", async () => {
    // Adding a card must not spend the others' unattended-call allowance.
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
    // Every object lands under the tenant's own prefix. The bucket is no longer
    // the sync's concern — it is bound when the adapter is constructed.
    expect(puts.every((p) => String(p["key"]).startsWith("tenant="))).toBe(true);
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
    // Not marked as synced — see the lastSyncedAt tests below.
    expect(updated).toHaveLength(0);
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

describe("sync window", () => {
  const spanDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

  it("asks for the full history while the exemption window is open", async () => {
    const { deps, gets } = fakes(() => ({ results: [{ account_id: "a1" }] }));
    const out = await refreshAndList(deps, {
      connection: connection({ connectedAt: new Date().toISOString() }),
    });
    expect(out.window.deepHistory).toBe(true);

    await fetchItem(deps, {
      tenantId: "frost",
      accessToken: "a",
      resource: "accounts",
      itemId: "a1",
      from: out.window.from,
      to: out.window.to,
    });
    const call = gets.find((g) => g.includes("/transactions?from="))!;
    const [, from, to] = call.match(/from=([0-9-]+)&to=([0-9-]+)/)!;
    expect(spanDays(from!, to!) / 365.25).toBeGreaterThan(4.9);
  });

  it("never asks for more than 88 days once it has closed", async () => {
    // 92 days was refused outright: the provider denies the whole call rather
    // than truncating, so every item failed and the ledger stopped moving.
    const { deps, gets } = fakes(() => ({ results: [{ account_id: "a1" }] }));
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const out = await refreshAndList(deps, { connection: connection({ connectedAt: old }) });

    await fetchItem(deps, {
      tenantId: "frost",
      accessToken: "a",
      resource: "accounts",
      itemId: "a1",
      from: out.window.from,
      to: out.window.to,
    });
    const call = gets.find((g) => g.includes("/transactions?from="))!;
    const [, from, to] = call.match(/from=([0-9-]+)&to=([0-9-]+)/)!;
    expect(spanDays(from!, to!)).toBeLessThanOrEqual(88);
  });

  it("falls back to a safe window rather than the full history", async () => {
    // A missing range must not widen into sixty months — that is exactly the
    // request the provider refuses.
    const { deps, gets } = fakes();
    await fetchItem(deps, { tenantId: "frost", accessToken: "a", resource: "accounts", itemId: "a1" });
    const call = gets.find((g) => g.includes("/transactions?from="))!;
    const [, from, to] = call.match(/from=([0-9-]+)&to=([0-9-]+)/)!;
    expect(spanDays(from!, to!)).toBeLessThanOrEqual(88);
  });
});

describe("lastSyncedAt", () => {
  it("advances only when every item succeeded", async () => {
    // The next window is measured from it. It used to move on any run that did
    // not hit an expired consent, so two days of every item failing still read
    // as "synced minutes ago" — and the gap would never have been revisited.
    const { deps, updated } = fakes();
    await recordOutcome(deps, {
      connection: connection(),
      results: [{ objects: 4 }, { Error: "TrueLayerError", Cause: "403" }],
    });
    expect(updated).toHaveLength(0);
  });

  it("advances on a clean run", async () => {
    const { deps, updated } = fakes();
    await recordOutcome(deps, { connection: connection(), results: [{ objects: 4 }] });
    expect(updated[0]?.lastSyncedAt).toBeDefined();
  });
});

describe("provider call accounting", () => {
  it("reports the calls a fetch spent", async () => {
    // Unattended access is capped at four per 24 hours for each account,
    // endpoint and consent. A run that
    // quietly spends more is invisible until the next one is refused — which is
    // how a card came to be fetched five times for one sync.
    const { deps } = fakes();
    const out = await fetchItem(deps, {
      tenantId: "frost",
      accessToken: "a",
      resource: "accounts",
      itemId: "acc-1",
    });
    expect(out.providerCalls).toBeGreaterThan(0);
  });

  it("dimensions metrics on the deployment, not the TrueLayer environment", async () => {
    // The bug this exists for: one field called `environment` served both
    // meanings, so the sync published Environment=live while every alarm in
    // infra/lib/ingest-stack.ts watched Environment=dev. ItemsFailed,
    // ConsentExpiring and the TransactionsFetched anomaly detector could not
    // fire, and because they treat missing data as not breaching they sat there
    // looking healthy. Confirmed against CloudWatch, which had seen both
    // dimensions in the namespace. See #31.
    const { deps } = fakes();
    const emitted: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => emitted.push(l));
    await recordOutcome(deps, { connection: connection(), results: [{ objects: 1 }] });
    spy.mockRestore();
    const doc = emitted.map((l) => JSON.parse(l)).find((d) => "ProviderCalls" in d);
    expect(doc.Environment).toBe("dev");
    expect(doc.Environment).not.toBe("live");
  });

  it("totals the listing step's calls with the items'", async () => {
    // refreshAndList spends calls the per-item results cannot know about.
    const { deps } = fakes();
    const emitted: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => emitted.push(l));
    await recordOutcome(deps, {
      connection: connection(),
      refreshCalls: 2,
      results: [{ providerCalls: 6 }, { providerCalls: 4 }],
    });
    spy.mockRestore();
    const doc = emitted.map((l) => JSON.parse(l)).find((d) => "ProviderCalls" in d);
    expect(doc.ProviderCalls).toBe(12);
  });

  it("times the run from when the listing step began", async () => {
    const { deps } = fakes();
    const emitted: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => emitted.push(l));
    await recordOutcome(deps, {
      connection: connection(),
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      results: [{ objects: 4 }],
    });
    spy.mockRestore();
    const doc = emitted.map((l) => JSON.parse(l)).find((d) => "SyncDurationMs" in d);
    expect(doc.SyncDurationMs).toBeGreaterThanOrEqual(4_900);
  });
});

describe("the two environments", () => {
  // They were one field called `environment` serving both meanings, which is
  // how the sync came to publish metrics under "live" while every alarm watched
  // "dev". Both sides of both fallbacks are asserted, so branch coverage does
  // not depend on which machine ran the suite. See #31.

  it("reads the deployment from ENVIRONMENT", () => {
    expect(stepEnvironments({ ENVIRONMENT: "prod" }).deploymentEnvironment).toBe("prod");
  });

  it("defaults the deployment to dev rather than leaving it undefined", () => {
    // An undefined dimension matches no alarm at all, which is a worse failure
    // than the wrong one: nothing to notice.
    expect(stepEnvironments({}).deploymentEnvironment).toBe("dev");
  });

  it("reports sandbox only when TL_ENV says so", () => {
    expect(stepEnvironments({ TL_ENV: "sandbox" }).providerEnvironment).toBe("sandbox");
  });

  it("treats anything else as live, including unset", () => {
    // The raw envelope records this, and a replay reads it to know what it is
    // replaying. Guessing sandbox for an unset value would mislabel real data.
    expect(stepEnvironments({}).providerEnvironment).toBe("live");
    expect(stepEnvironments({ TL_ENV: "" }).providerEnvironment).toBe("live");
  });

  it("keeps the two apart when both are set", () => {
    // The whole bug in one assertion: live data deployed to prod must dimension
    // metrics on prod, not on live.
    expect(stepEnvironments({ TL_ENV: "live", ENVIRONMENT: "prod" })).toEqual({
      providerEnvironment: "live",
      deploymentEnvironment: "prod",
    });
  });
});
