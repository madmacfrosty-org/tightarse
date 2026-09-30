import { describe, it, expect, vi } from "vitest";
import {
  reconfirmConnection,
  connectionForConsent,
  ConsentNotRenewable,
  ConsentUnknown,
  connectRoutes,
  type ConnectDeps,
} from "../src/connect.js";
import type { Connection } from "../src/connections.js";

/**
 * Renewing a consent before it lapses.
 *
 * Every id, institution and date invented. This repository is public.
 */
const NOW = new Date("2026-09-30T12:00:00.000Z");

/** `unlinked` rather than `credentialsId: undefined`, which exactOptionalPropertyTypes forbids. */
const unlinked = (c: Connection): Connection => {
  const { credentialsId: _drop, ...rest } = c;
  return rest;
};

const connection = (over: Partial<Connection> = {}): Connection => ({
  connectionId: "conn-1",
  tenantId: "t1",
  provider: "truelayer",
  refreshToken: "rt-original",
  // Six weeks out, so it has not lapsed.
  consentExpiresAt: "2026-11-11T00:00:00.000Z",
  connectedAt: "2026-08-13T00:00:00.000Z",
  credentialsId: "cred-1",
  ...over,
});

function deps(over: Partial<ConnectDeps> = {}, stored: Connection[] = [connection()]) {
  const rows = [...stored];
  const update = vi.fn(async (c: Connection) => {
    rows[rows.findIndex((r) => r.connectionId === c.connectionId)] = c;
  });
  const extendConnection = vi.fn(async () => ({
    action: "renewed" as const,
    tokens: {
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: "2026-12-29T00:00:00.000Z",
    },
  }));
  const d = {
    truelayer: {
      refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
      get: vi.fn(async () => ({ status: 200, body: { results: [{ credentials_id: "cred-1" }] } })),
      extendConnection,
    },
    connections: { list: vi.fn(async () => rows), update },
    redirectUri: "https://example.invalid/connected",
    providers: "uk-ob-all",
    clientId: "client",
    authBase: "https://auth.invalid",
    ownsConnections: true,
    ...over,
  } as unknown as ConnectDeps;
  return { deps: d, update, extendConnection, rows };
}

describe("renewing a consent", () => {
  it("stores the new refresh token, because the old one stops working", async () => {
    // The whole risk in this operation. The provider issues a new token and
    // invalidates the old one in the same moment, so a renewal that reports
    // success without storing has killed the connection — and the symptom
    // arrives days later, when the next sync fails.
    const { deps: d, update } = deps();

    const out = await reconfirmConnection(d, "t1", "cred-1", NOW);

    expect(out).toMatchObject({ action: "renewed", expiresAt: "2026-12-29T00:00:00.000Z" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      connectionId: "conn-1",
      refreshToken: "rt-new",
      consentExpiresAt: "2026-12-29T00:00:00.000Z",
    });
  });

  it("hands back a link when the provider wants a person, and stores nothing", async () => {
    // Nothing has changed at the provider yet, so writing anything here would
    // record a renewal that has not happened.
    const { deps: d, update } = deps({
      truelayer: {
        refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: vi.fn(async () => ({
          action: "authentication" as const,
          continueAt: "https://login.example.invalid/?session=1",
        })),
      },
    } as unknown as Partial<ConnectDeps>);

    const out = await reconfirmConnection(d, "t1", "cred-1", NOW);

    expect(out).toMatchObject({
      action: "authentication",
      continueAt: "https://login.example.invalid/?session=1",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses one that has already lapsed, rather than asking the provider", async () => {
    // There is nothing left to extend, and the remedy is a fresh connection —
    // a different act, with a different cost, that the household must choose.
    const { deps: d, extendConnection } = deps({}, [
      connection({ consentExpiresAt: "2026-09-01T00:00:00.000Z" }),
    ]);

    await expect(reconfirmConnection(d, "t1", "cred-1", NOW)).rejects.toBeInstanceOf(
      ConsentNotRenewable,
    );
    expect(extendConnection).not.toHaveBeenCalled();
  });

  it("says so when no connection matches the consent", async () => {
    const { deps: d } = deps({}, [connection({ credentialsId: "other" })]);
    await expect(reconfirmConnection(d, "t1", "cred-1", NOW)).rejects.toBeInstanceOf(ConsentUnknown);
  });
});

describe("linking a consent to the connection behind it", () => {
  it("costs nothing when the link is already stored", async () => {
    // The normal case, and the one that keeps this off the unattended
    // allowance: four calls per account, endpoint and consent per day.
    const { deps: d } = deps();
    const found = await connectionForConsent(d, "t1", "cred-1");

    expect(found.connectionId).toBe("conn-1");
    expect(d.truelayer.get).not.toHaveBeenCalled();
  });

  it("resolves an unlinked connection once and remembers the answer", async () => {
    // Connections made before the link existed have to be asked about. Storing
    // the answer is what makes it once per connection rather than once per
    // renewal.
    const { deps: d, update } = deps({}, [unlinked(connection())]);

    const found = await connectionForConsent(d, "t1", "cred-1");

    expect(found.credentialsId).toBe("cred-1");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({ credentialsId: "cred-1" });
  });
});

describe("who may renew", () => {
  it("refuses a deployment that does not own the connections", async () => {
    // The dashboard hides the control in dev, but a control that is not
    // rendered is not a control that cannot be called.
    const { deps: d, extendConnection } = deps({ ownsConnections: false });

    const res = await connectRoutes(d, {
      rawPath: "/v1/connections/reconfirm",
      body: JSON.stringify({ consentId: "cred-1" }),
      requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "t1" } } } },
    });

    expect(res.statusCode).toBe(403);
    expect(extendConnection).not.toHaveBeenCalled();
  });

  it("acts for a deployment that does", async () => {
    const { deps: d, extendConnection } = deps({ ownsConnections: true });

    const res = await connectRoutes(d, {
      rawPath: "/v1/connections/reconfirm",
      body: JSON.stringify({ consentId: "cred-1" }),
      requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "t1" } } } },
    });

    expect(res.statusCode).toBe(200);
    expect(extendConnection).toHaveBeenCalledTimes(1);
  });
});
