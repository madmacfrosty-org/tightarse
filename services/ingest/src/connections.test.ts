import { describe, it, expect, vi } from "vitest";
import { Connections, type Connection } from "./connections.js";

/**
 * Where bank refresh tokens live.
 *
 * These are the credential a connection is: lose one and the household goes
 * back through a bank authorisation journey, and the deep-history window that
 * comes with it has already closed. The module was at 22% of functions.
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

/** A Secrets Manager that records what it was asked to do. */
function fakeClient(responses: Array<Record<string, unknown>> = []) {
  const sent: Array<Record<string, unknown>> = [];
  let call = 0;
  return {
    sent,
    client: {
      send: async (cmd: { input: Record<string, unknown> }) => {
        sent.push(cmd.input);
        return responses[call++] ?? {};
      },
    },
  };
}

const connections = (responses?: Array<Record<string, unknown>>) => {
  const { client, sent } = fakeClient(responses);
  return { sent, connections: new Connections("tightarse/dev/truelayer/connections", client as never) };
};

describe("naming a connection's secret", () => {
  it("scopes the name by household, so two households cannot collide", () => {
    // The name is the only thing separating them: one Secrets Manager, one
    // prefix, and a tenant that comes from a verified claim.
    const { connections: c, sent } = connections();
    return c.create(connection()).then(() => {
      expect(sent[0]!["Name"]).toBe("tightarse/dev/truelayer/connections/frost/conn-1");
    });
  });

  it("tags the secret with the household, so cost and access can be attributed", async () => {
    const { connections: c, sent } = connections();
    await c.create(connection());
    expect(sent[0]!["Tags"]).toEqual([{ Key: "tenant", Value: "frost" }]);
  });

  it("stores the whole connection, refresh token included", async () => {
    // The refresh token is the entire point: a consent without one is a
    // snapshot, not a connection.
    const { connections: c, sent } = connections();
    await c.create(connection());
    expect(JSON.parse(String(sent[0]!["SecretString"]))).toMatchObject({
      refreshToken: "the-refresh-token",
      consentExpiresAt: "2026-11-08T00:00:00.000Z",
    });
  });
});

describe("reading a connection back", () => {
  it("returns the stored connection", async () => {
    const { connections: c } = connections([{ SecretString: JSON.stringify(connection()) }]);
    expect(await c.get("frost", "conn-1")).toMatchObject({ refreshToken: "the-refresh-token" });
  });

  it("returns null rather than throwing when there is no such connection", async () => {
    // A caller deciding what to sync should get an empty answer, not an
    // exception that fails the whole run for one missing connection.
    const { connections: c } = connections([{}]);
    expect(await c.get("frost", "missing")).toBeNull();
  });

  it("returns null when Secrets Manager refuses the read", async () => {
    // ResourceNotFoundException is the normal answer for a connection that was
    // deleted, and it arrives as a thrown error rather than an empty result.
    // Letting it escape would fail an entire sync over one revoked consent.
    const client = { send: async () => { throw new Error("ResourceNotFoundException"); } };
    const c = new Connections("tightarse/dev/truelayer/connections", client as never);
    expect(await c.get("frost", "revoked")).toBeNull();
  });
});

describe("listing a household's connections", () => {
  it("follows pagination, so a household is never partly synced", async () => {
    // Stopping at the first page would silently skip connections, and the
    // accounts behind them would go stale with nothing reporting it.
    const { connections: c } = connections([
      { SecretList: [{ Name: "a" }], NextToken: "more" },
      { SecretString: JSON.stringify(connection({ connectionId: "a" })) },
      { SecretList: [{ Name: "b" }] },
      { SecretString: JSON.stringify(connection({ connectionId: "b" })) },
    ]);
    const all = await c.list("frost");
    expect(all.map((x) => x.connectionId)).toEqual(["a", "b"]);
  });

  it("filters by the household's own prefix", async () => {
    const { connections: c, sent } = connections([{ SecretList: [] }]);
    await c.list("frost");
    expect(sent[0]!["Filters"]).toEqual([
      { Key: "name", Values: ["tightarse/dev/truelayer/connections/frost/"] },
    ]);
  });

  it("skips an entry with no name rather than failing the list", async () => {
    const { connections: c } = connections([{ SecretList: [{}, { Name: "b" }] }, { SecretString: JSON.stringify(connection()) }]);
    expect(await c.list("frost")).toHaveLength(1);
  });

  it("skips a secret with no value rather than returning a broken connection", async () => {
    // A half-created secret should not become a connection object with no
    // refresh token, which would then fail confusingly at refresh time.
    const { connections: c } = connections([{ SecretList: [{ Name: "a" }] }, {}]);
    expect(await c.list("frost")).toEqual([]);
  });
});

describe("removing a connection", () => {
  it("deletes without a recovery window", async () => {
    // Secrets Manager holds a deleted secret for 7 to 30 days by default, and
    // the name cannot be reused while it does — so a household reconnecting the
    // same bank would fail to create its replacement.
    const { connections: c, sent } = connections();
    await c.delete("frost", "conn-1");
    expect(sent[0]).toMatchObject({
      SecretId: "tightarse/dev/truelayer/connections/frost/conn-1",
      ForceDeleteWithoutRecovery: true,
    });
  });
});

describe("persisting a rotated refresh token", () => {
  it("writes the whole connection back, not just the token", async () => {
    // Called after every refresh, unconditionally: TrueLayer may hand back a
    // new refresh token and invalidate the old one, and writing it back is the
    // difference between a connection that keeps working and one that dies
    // quietly a few days later.
    const { connections: c, sent } = connections();
    await c.update(connection({ refreshToken: "rotated" }));
    expect(sent[0]).toMatchObject({ SecretId: "tightarse/dev/truelayer/connections/frost/conn-1" });
    expect(JSON.parse(String(sent[0]!["SecretString"]))).toMatchObject({ refreshToken: "rotated" });
  });
});

describe("constructing without a client", () => {
  it("builds its own Secrets Manager client, which is what the Lambda does", () => {
    // Every test above passes a fake, so this default is the path that only
    // ever runs in production.
    expect(new Connections("tightarse/dev/truelayer/connections")).toBeInstanceOf(Connections);
  });
});
