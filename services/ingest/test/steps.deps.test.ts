import { describe, it, expect, vi } from "vitest";
import { ConsentExpired } from "@tightarse/ports";
import {
  listConnections,
  refreshAndList,
  fetchItem,
  recordOutcome,
  type StepDeps,
  stepEnvironments,
} from "../src/steps.js";
import type { Connection } from "../src/connections.js";

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
  fetched: Array<{ item: { resource: string; itemId: string }; window: { from: string; to: string } }>;
  puts: Array<Record<string, unknown>>;
  updated: Connection[];
  published: string[];
}

/** Records what was asked of the outside world, and answers plausibly. */
function fakes(
  responses: (path: string) => unknown | Promise<unknown> = () => ({ results: [] }),
): Fakes {
  const fetched: Array<{ item: { resource: string; itemId: string }; window: { from: string; to: string } }> = [];
  let calls = 0;
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
    // A BankData fake. Which URLs get called, and which endpoints exist for a
    // card versus an account, is the adapter's business and is tested against the
    // adapter in packages/truelayer. What matters here is what the sync does with
    // what comes back.
    bank: {
      limits: { maxHistoryMonths: 60, unattendedHistoryDays: 88, exemptionMinutes: 45 },
      get calls() {
        return calls;
      },
      refresh: vi.fn(async () => ({
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })),
      listItems: vi.fn(async () => {
        calls += 1;
        const body = await responses("/data/v1/accounts");
        const results = (body as { results?: Array<{ account_id?: string }> }).results ?? [];
        return {
          items: results.flatMap((r) => (r.account_id ? [{ resource: "accounts", itemId: r.account_id }] : [])),
          payloads: [{ dataset: "truelayer.accounts", itemId: null, body }],
          skipped: [] as string[],
        };
      }),
      fetchItem: vi.fn(
        async (
          _token: string,
          item: { resource: string; itemId: string },
          window: { from: string; to: string },
        ) => {
          calls += 1;
          fetched.push({ item, window });
          const body = await responses(`/data/v1/${item.resource}/${item.itemId}/transactions`);
          const prefix = item.resource === "cards" ? "truelayer.card_" : "truelayer.";
          return {
            payloads: [
              { dataset: `${prefix}transactions`, itemId: item.itemId, body, window },
              { dataset: `truelayer.${item.resource}`, itemId: item.itemId, body: {} },
            ],
            skipped: [] as string[],
            transactions: ((body as { results?: unknown[] }).results ?? []).length,
          };
        },
      ),
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

  return { deps, fetched, puts, updated, published };
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
    (deps.bank.refresh as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ConsentExpired("consent expired"),
    );
    const out = await refreshAndList(deps, { connection: connection() });
    expect(out.consentExpired).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("lets a transient refresh failure through, so the state machine retries it", async () => {
    // Only ConsentExpired means a person must act. A 500 from the token endpoint
    // swallowed as a lapsed consent would send someone to re-authorise a
    // connection that is working, and would mark the run finished when it was
    // not.
    const { deps } = fakes();
    (deps.bank.refresh as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("token endpoint 500"));
    await expect(refreshAndList(deps, { connection: connection() })).rejects.toThrow(/500/);
  });

  it("skips a resource the provider does not offer", async () => {
    // Amex is cards-only and has no accounts scope at all. A missing resource is
    // a shape, not a failure. Which status codes mean that is the adapter's to
    // decide; the sync only has to carry the answer through.
    const { deps } = fakes();
    (deps.bank.listItems as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ resource: "cards", itemId: "card-1" }],
      payloads: [{ dataset: "truelayer.cards", itemId: null, body: {} }],
      skipped: ["accounts"],
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

  it("asks the provider once for the item, and lands everything it returns", async () => {
    // Which endpoints that means, and in what order, moved to the adapter with
    // the URLs. What the sync is responsible for is that every payload reaches
    // the raw zone and the count reflects it.
    const { deps, fetched, puts } = fakes();
    const out = await fetchItem(deps, input);
    expect(fetched).toEqual([
      { item: { resource: "accounts", itemId: "acc-1" }, window: { from: expect.any(String), to: expect.any(String) } },
    ]);
    expect(out.objects).toBe(2);
    expect(puts).toHaveLength(2);
  });

  it("lands each payload under the dataset the provider named it with", async () => {
    // The raw zone is keyed by dataset and a replay reads it back to know what
    // it is looking at, so the adapter's name has to survive the journey.
    const { deps, puts } = fakes();
    await fetchItem(deps, { ...input, resource: "cards", itemId: "card-1" });
    const keys = puts.map((p) => String(p["key"]));
    expect(keys.some((k) => k.includes("card_transactions"))).toBe(true);
  });

  it("carries through an endpoint the provider refuses, rather than failing", async () => {
    // First Direct returns 501 for standing orders everywhere and 403 for direct
    // debits on accounts that have none. Alarming on those trains everyone to
    // ignore alarms.
    const { deps } = fakes();
    (deps.bank.fetchItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      payloads: [{ dataset: "truelayer.transactions", itemId: "acc-1", body: { results: [] } }],
      skipped: ["truelayer.standing_orders acc-1", "truelayer.direct_debits acc-1"],
      transactions: 0,
    });
    const out = await fetchItem(deps, input);
    expect(out.skipped).toHaveLength(2);
    expect(out.objects).toBeGreaterThan(0);
  });

  it("still fails on a genuine error, so the state machine retries it", async () => {
    const { deps } = fakes();
    (deps.bank.fetchItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
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

  /** The window the sync actually asked the provider for. */
  const asked = (fetched: Array<{ window: { from: string; to: string } }>) => {
    const w = fetched[0]!.window;
    return spanDays(w.from, w.to);
  };

  it("asks for the full history while the exemption window is open", async () => {
    const { deps, fetched } = fakes(() => ({ results: [{ account_id: "a1" }] }));
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
    expect(asked(fetched) / 365.25).toBeGreaterThan(4.9);
  });

  it("never asks for more than 88 days once it has closed", async () => {
    // 92 days was refused outright: the provider denies the whole call rather
    // than truncating, so every item failed and the ledger stopped moving.
    const { deps, fetched } = fakes(() => ({ results: [{ account_id: "a1" }] }));
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
    expect(asked(fetched)).toBeLessThanOrEqual(88);
  });

  it("falls back to a safe window rather than the full history", async () => {
    // A missing range must not widen into sixty months — that is exactly the
    // request the provider refuses.
    const { deps, fetched } = fakes();
    await fetchItem(deps, { tenantId: "frost", accessToken: "a", resource: "accounts", itemId: "a1" });
    expect(asked(fetched)).toBeLessThanOrEqual(88);
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
