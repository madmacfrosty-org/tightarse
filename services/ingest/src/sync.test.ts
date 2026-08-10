import { describe, it, expect, vi } from "vitest";
import { TrueLayerError } from "@tightarse/truelayer";
import { syncConnection } from "./sync.js";
import { consentExpiry, daysUntilExpiry, type Connection } from "./connections.js";

const connection: Connection = {
  connectionId: "conn1",
  tenantId: "frost",
  provider: "truelayer",
  refreshToken: "original",
  consentExpiresAt: new Date(Date.now() + 60 * 864e5).toISOString(),
  connectedAt: new Date().toISOString(),
};

function deps(over: Partial<Record<string, unknown>> = {}) {
  const updates: Connection[] = [];
  const puts: Array<{ Key: string }> = [];
  return {
    updates,
    puts,
    deps: {
      truelayer: {
        refresh: vi.fn(async () => ({
          accessToken: "access",
          refreshToken: "rotated",
          expiresAt: new Date(Date.now() + 3600e3).toISOString(),
        })),
        get: vi.fn(async (_t: string, path: string) => {
          if (path === "/data/v1/accounts") {
            return { status: 200, body: { results: [{ account_id: "accA" }] } };
          }
          return { status: 200, body: { results: [] } };
        }),
        ...(over["truelayer"] as object),
      },
      connections: {
        update: vi.fn(async (c: Connection) => {
          updates.push(c);
        }),
      },
      s3: { send: vi.fn(async (cmd: { input: { Key: string } }) => puts.push({ Key: cmd.input.Key })) },
      bucket: "bucket",
    } as never,
  };
}

describe("syncConnection", () => {
  it("persists a rotated refresh token before doing anything else", async () => {
    // If the rotation is not saved, the next run authenticates with a token the
    // provider has already invalidated and the connection dies quietly.
    const { deps: d, updates } = deps();
    await syncConnection(d, connection);
    expect(updates[0]?.refreshToken).toBe("rotated");
  });

  it("writes one raw object per response, tenant-first", async () => {
    const { deps: d, puts } = deps();
    const result = await syncConnection(d, connection);
    expect(result.objectsWritten).toBeGreaterThan(0);
    for (const p of puts) expect(p.Key.startsWith("tenant=frost/dataset=truelayer.")).toBe(true);
  });

  it("reports a lapsed consent instead of throwing", async () => {
    // A human has to reconnect at the bank. Throwing would look like a
    // transient failure and be retried for ever.
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async () => {
          throw new TrueLayerError("no", 400, "invalid_grant");
        }),
      },
    });
    const result = await syncConnection(d, connection);
    expect(result.consentExpired).toBe(true);
    expect(result.objectsWritten).toBe(0);
  });

  it("skips endpoints the provider does not offer, without failing the sync", async () => {
    // First Direct returns 501 for standing orders on every account and 403 for
    // direct debits where there are none. Alarming on those trains everyone to
    // ignore alarms.
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async () => ({
          accessToken: "a", refreshToken: "r", expiresAt: new Date().toISOString(),
        })),
        get: vi.fn(async (_t: string, path: string) => {
          if (path === "/data/v1/accounts") return { status: 200, body: { results: [{ account_id: "accA" }] } };
          if (path.includes("standing_orders")) throw new TrueLayerError("no", 501, "endpoint_not_supported");
          if (path.includes("direct_debits")) throw new TrueLayerError("no", 403, "access_denied");
          return { status: 200, body: { results: [] } };
        }),
      },
    });
    const result = await syncConnection(d, connection);
    expect(result.skipped).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("records a genuine failure without abandoning the rest", async () => {
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async () => ({
          accessToken: "a", refreshToken: "r", expiresAt: new Date().toISOString(),
        })),
        get: vi.fn(async (_t: string, path: string) => {
          if (path === "/data/v1/accounts") return { status: 200, body: { results: [{ account_id: "accA" }] } };
          if (path.includes("/transactions?")) throw new TrueLayerError("boom", 500, null);
          return { status: 200, body: { results: [] } };
        }),
      },
    });
    const result = await syncConnection(d, connection);
    expect(result.errors.some((e) => e.startsWith("transactions"))).toBe(true);
    // Balances and the rest still landed.
    expect(result.objectsWritten).toBeGreaterThan(0);
  });
});

describe("consent expiry", () => {
  it("is 90 days from connection, recorded absolutely", () => {
    const at = new Date("2026-08-10T00:00:00Z");
    expect(consentExpiry(at).slice(0, 10)).toBe("2026-11-08");
  });

  it("counts down and goes negative once lapsed", () => {
    // The clock is pinned. Deriving both the expiry and "now" from Date.now()
    // makes the result flip between 4 and 5 depending on whether the two calls
    // land in the same millisecond — a test that fails once a fortnight in CI
    // and teaches everyone to re-run rather than look.
    const now = new Date("2026-08-10T12:00:00Z");
    const soon = { ...connection, consentExpiresAt: "2026-08-15T12:00:00Z" };
    const gone = { ...connection, consentExpiresAt: "2026-08-08T12:00:00Z" };
    expect(daysUntilExpiry(soon, now)).toBe(5);
    expect(daysUntilExpiry(gone, now)).toBe(-2);
  });
});
