import { describe, it, expect } from "vitest";
import type { Secrets } from "@tightarse/ports";
import { Connections, type Connection } from "../src/connections.js";

/**
 * Where bank refresh tokens live.
 *
 * These are the credential a connection is: lose one and the household goes
 * back through a bank authorisation journey, and the deep-history window that
 * comes with it has already closed.
 *
 * Against a fake `Secrets`, not a fake Secrets Manager client. What this class
 * does is name and serialise connections; whether a store is created with
 * `CreateSecret` or `PutSecretValue`, and how a tag is shaped, is the adapter's
 * business and is tested there. Asserting on command inputs here made these
 * tests fail when the AWS call changed and pass when the naming broke.
 */

const connection = (over: Partial<Connection> = {}): Connection => ({
  connectionId: "conn-1",
  tenantId: "frost",
  provider: "truelayer",
  refreshToken: "the-refresh-token",
  consentExpiresAt: "2026-11-08T00:00:00.000Z",
  connectedAt: "2026-08-10T00:00:00.000Z",
  ...over,
});

interface Stored {
  value: string;
  opts?: { description?: string; tags?: Record<string, string> } | undefined;
}

/** An in-memory Secrets, behaving as the real one is specified to behave. */
function fakeSecrets(seed: Record<string, string> = {}) {
  const store = new Map<string, Stored>(
    Object.entries(seed).map(([k, value]) => [k, { value }]),
  );
  const secrets: Secrets = {
    get: async (name) => store.get(name)?.value,
    set: async (name, value, opts) => {
      store.set(name, { value, opts });
    },
    // The port's contract: names under the prefix, already paged.
    list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
  };
  return { secrets, store };
}

const PREFIX = "tightarse/dev/truelayer/connections";
const NAME = `${PREFIX}/frost/conn-1`;

describe("naming a connection's secret", () => {
  it("scopes the name by household, so two households cannot collide", async () => {
    // The name is the only thing separating them: one Secrets Manager, one
    // prefix, and a tenant that comes from a verified claim.
    const { secrets, store } = fakeSecrets();
    await new Connections(PREFIX, secrets).create(connection());
    expect([...store.keys()]).toEqual([NAME]);
  });

  it("keeps one household's connection out of another's list", async () => {
    // The prefix filter is what enforces the boundary, and a prefix that
    // matched loosely would hand one household another's refresh tokens.
    const { secrets } = fakeSecrets({
      [`${PREFIX}/frost/a`]: JSON.stringify(connection({ connectionId: "a" })),
      [`${PREFIX}/frostier/b`]: JSON.stringify(
        connection({ connectionId: "b", tenantId: "frostier" }),
      ),
    });
    const all = await new Connections(PREFIX, secrets).list("frost");
    expect(all.map((c) => c.connectionId)).toEqual(["a"]);
  });
});

describe("creating a connection", () => {
  it("attributes the secret to the household, so cost and access can be traced", async () => {
    const { secrets, store } = fakeSecrets();
    await new Connections(PREFIX, secrets).create(connection());
    expect(store.get(NAME)!.opts).toEqual({
      description: "TrueLayer connection for frost",
      tags: { tenant: "frost" },
    });
  });

  it("stores the whole connection, refresh token included", async () => {
    // The refresh token is the entire point: a consent without one is a
    // snapshot, not a connection.
    const { secrets, store } = fakeSecrets();
    await new Connections(PREFIX, secrets).create(connection());
    expect(JSON.parse(store.get(NAME)!.value)).toMatchObject({
      refreshToken: "the-refresh-token",
      consentExpiresAt: "2026-11-08T00:00:00.000Z",
    });
  });
});

describe("reading a connection back", () => {
  it("returns the stored connection", async () => {
    const { secrets } = fakeSecrets({ [NAME]: JSON.stringify(connection()) });
    expect(await new Connections(PREFIX, secrets).get("frost", "conn-1")).toMatchObject({
      refreshToken: "the-refresh-token",
    });
  });

  it("returns null rather than throwing when there is no such connection", async () => {
    // A caller deciding what to sync should get an empty answer, not an
    // exception that fails the whole run for one revoked consent.
    const { secrets } = fakeSecrets();
    expect(await new Connections(PREFIX, secrets).get("frost", "missing")).toBeNull();
  });
});

describe("listing a household's connections", () => {
  it("returns every connection the household has", async () => {
    const { secrets } = fakeSecrets({
      [`${PREFIX}/frost/a`]: JSON.stringify(connection({ connectionId: "a" })),
      [`${PREFIX}/frost/b`]: JSON.stringify(connection({ connectionId: "b" })),
    });
    const all = await new Connections(PREFIX, secrets).list("frost");
    expect(all.map((c) => c.connectionId)).toEqual(["a", "b"]);
  });

  it("skips a secret with no value rather than returning a broken connection", async () => {
    // A half-created secret must not become a connection object with no refresh
    // token, which would then fail confusingly at refresh time.
    const { secrets } = fakeSecrets();
    const withGap: Secrets = { ...secrets, list: async () => [`${PREFIX}/frost/a`] };
    expect(await new Connections(PREFIX, withGap).list("frost")).toEqual([]);
  });

  it("returns nothing for a household with no connections", async () => {
    const { secrets } = fakeSecrets();
    expect(await new Connections(PREFIX, secrets).list("frost")).toEqual([]);
  });
});

describe("persisting a rotated refresh token", () => {
  it("writes the whole connection back, not just the token", async () => {
    // Called after every refresh, unconditionally: TrueLayer may hand back a new
    // refresh token and invalidate the old one, and writing it back is the
    // difference between a connection that keeps working and one that dies
    // quietly a few days later.
    const { secrets, store } = fakeSecrets({ [NAME]: JSON.stringify(connection()) });
    await new Connections(PREFIX, secrets).update(connection({ refreshToken: "rotated" }));
    expect(JSON.parse(store.get(NAME)!.value)).toMatchObject({
      refreshToken: "rotated",
      consentExpiresAt: "2026-11-08T00:00:00.000Z",
    });
  });
});
