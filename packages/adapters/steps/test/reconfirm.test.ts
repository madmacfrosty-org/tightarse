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

describe("what the renewal route says when it cannot act", () => {
  const call = (d: ConnectDeps, body: unknown, base64 = false) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return connectRoutes(d, {
      rawPath: "/v1/connections/reconfirm",
      body: base64 ? Buffer.from(raw, "utf8").toString("base64") : raw,
      isBase64Encoded: base64,
      requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "t1" } } } },
    });
  };

  it("asks for a consentId rather than failing obscurely", async () => {
    const { deps: d } = deps();
    expect((await call(d, {})).statusCode).toBe(400);
  });

  it("treats a body that is not JSON as a missing one", async () => {
    // API Gateway hands a string and does not promise it parses. A crash here
    // is a 500 for what is plainly a bad request.
    const { deps: d } = deps();
    expect((await call(d, "not json at all")).statusCode).toBe(400);
  });

  it("reads a base64 body, because the gateway sometimes sends one", async () => {
    // Decided by API Gateway rather than by the caller, so a handler that
    // ignores the flag works until the day the encoding changes under it.
    const { deps: d } = deps();
    expect((await call(d, { consentId: "cred-1" }, true)).statusCode).toBe(200);
  });

  it("says 409 for a consent that has already lapsed", async () => {
    // Distinguishable from a failure: nothing broke, and the answer is that
    // this needs connecting again rather than renewing.
    const { deps: d } = deps({}, [connection({ consentExpiresAt: "2026-01-01T00:00:00.000Z" })]);
    expect((await call(d, { consentId: "cred-1" })).statusCode).toBe(409);
  });

  it("says 404 when nothing matches the consent", async () => {
    const { deps: d } = deps({}, [connection({ credentialsId: "someone-else" })]);
    expect((await call(d, { consentId: "cred-1" })).statusCode).toBe(404);
  });

  it("says 502 when the provider refuses, not 500", async () => {
    // Somebody else's service being unhappy is not this service failing, and
    // the two want different responses from whoever is watching.
    const { TrueLayerError } = await import("@tightarse/truelayer");
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: vi.fn(async () => {
          throw new TrueLayerError("nope", 503, "unavailable");
        }),
      },
    } as unknown as Partial<ConnectDeps>);

    expect((await call(d, { consentId: "cred-1" })).statusCode).toBe(502);
  });
});

describe("resolving the link when the provider is unhelpful", () => {
  it("skips a connection whose /me says nothing, rather than stopping", async () => {
    // One connection that cannot identify itself must not prevent renewing a
    // different one. The scan returns whatever the provider gives.
    const rows = [unlinked(connection({ connectionId: "quiet" })), connection()];
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { results: [] } })
      .mockResolvedValue({ status: 200, body: { results: [{ credentials_id: "cred-1" }] } });
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
        get,
        extendConnection: vi.fn(),
      },
    } as unknown as Partial<ConnectDeps>, rows);

    // The linked one matches without a call; the quiet one is never reached.
    const found = await connectionForConsent(d, "t1", "cred-1");
    expect(found.connectionId).toBe("conn-1");
  });

  it("remembers a connection that identifies as something else", async () => {
    // Probed once and stored even though it was not the one wanted, so the
    // next renewal of a different consent does not pay for it again.
    const { deps: d, update } = deps(
      {
        truelayer: {
          refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
          get: vi.fn(async () => ({ status: 200, body: { results: [{ credentials_id: "other" }] } })),
          extendConnection: vi.fn(),
        },
      } as unknown as Partial<ConnectDeps>,
      [unlinked(connection())],
    );

    await expect(connectionForConsent(d, "t1", "cred-1")).rejects.toBeInstanceOf(ConsentUnknown);
    expect(update.mock.calls[0]![0]).toMatchObject({ credentialsId: "other" });
  });

  it("refuses a request carrying no household claim", async () => {
    // The household comes from a verified claim and never from the request,
    // the same rule the read API applies.
    const { deps: d } = deps();
    const res = await connectRoutes(d, {
      rawPath: "/v1/connections/reconfirm",
      body: JSON.stringify({ consentId: "cred-1" }),
      requestContext: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("the shapes the provider can actually return", () => {
  const probing = (get: ReturnType<typeof vi.fn>, rows: Connection[]) =>
    deps(
      {
        truelayer: {
          refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
          get,
          extendConnection: vi.fn(async () => ({
            action: "renewed" as const,
            tokens: { accessToken: "a", refreshToken: "rt-new", expiresAt: "2026-12-29T00:00:00.000Z" },
          })),
        },
      } as unknown as Partial<ConnectDeps>,
      rows,
    );

  it("carries on past a connection whose /me has no results key at all", async () => {
    // Not an empty array — absent. The reference types almost everything on
    // /me as optional, so a response with nothing in it is within contract and
    // must not throw on the way to the connection that does match.
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: {} })
      .mockResolvedValueOnce({ status: 200, body: { results: [{ credentials_id: "cred-1" }] } });
    const { deps: d } = probing(get, [
      unlinked(connection({ connectionId: "quiet" })),
      unlinked(connection({ connectionId: "conn-1" })),
    ]);

    const found = await connectionForConsent(d, "t1", "cred-1");

    expect(found.connectionId).toBe("conn-1");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("carries on past one that answers with no id", async () => {
    // The `continue`: a connection that cannot say who it is gets skipped
    // rather than stored under a name it did not give.
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { results: [{}] } })
      .mockResolvedValueOnce({ status: 200, body: { results: [{ credentials_id: "cred-1" }] } });
    const { deps: d, update } = probing(get, [
      unlinked(connection({ connectionId: "quiet" })),
      unlinked(connection({ connectionId: "conn-1" })),
    ]);

    const found = await connectionForConsent(d, "t1", "cred-1");

    expect(found.connectionId).toBe("conn-1");
    // Only the one that identified itself is remembered.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({ connectionId: "conn-1" });
  });

  it("reports a provider refusal that carries no error code", async () => {
    // TrueLayerError takes a null code, and a template that assumed a string
    // would print "undefined" into the message somebody reads.
    const { TrueLayerError } = await import("@tightarse/truelayer");
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: vi.fn(async () => {
          throw new TrueLayerError("nope", 500, null);
        }),
      },
    } as unknown as Partial<ConnectDeps>);

    const res = await connectRoutes(d, {
      rawPath: "/v1/connections/reconfirm",
      body: JSON.stringify({ consentId: "cred-1" }),
      requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "t1" } } } },
    });

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("undefined");
  });

  it("treats a request with no body as a bad one", async () => {
    // A POST can arrive without one, and reading it as JSON would throw.
    const { deps: d } = deps();
    const res = await connectRoutes(d, {
      rawPath: "/v1/connections/reconfirm",
      requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "t1" } } } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("telling the ledger a renewal happened", () => {
  const landing = (over: Partial<ConnectDeps> = {}) => {
    // Typed, so `put.mock.calls` carries the arguments rather than an empty
    // tuple — otherwise the assertions below index into nothing.
    const put = vi.fn(
      async (_key: string, _body: Buffer, _opts: Record<string, unknown>) => {},
    );
    const get = vi.fn(async () => ({
      status: 200,
      body: { results: [{ credentials_id: "cred-1", consent_expires_at: "2027-01-02T00:00:00Z" }] },
    }));
    const { deps: d, update } = deps({
      raw: { put } as unknown as ConnectDeps["raw"],
      truelayer: {
        refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
        get,
        extendConnection: vi.fn(async () => ({
          action: "renewed" as const,
          tokens: { accessToken: "at-new", refreshToken: "rt-new", expiresAt: "2026-12-29T00:00:00.000Z" },
        })),
      },
      ...over,
    } as unknown as Partial<ConnectDeps>);
    return { deps: d, put, get, update };
  };

  it("lands a fresh /me so the transform rewrites the consent row", async () => {
    // The dashboard reads consent rows from DynamoDB and the sync writes them,
    // so without this a renewal shows yesterday's expiry until tomorrow and
    // looks like it did nothing.
    const { deps: d, put, get } = landing();

    await reconfirmConnection(d, "t1", "cred-1", NOW);

    expect(get).toHaveBeenCalledWith("at-new", "/data/v1/me");
    expect(put).toHaveBeenCalledTimes(1);
    const [key] = put.mock.calls[0]!;
    // Under `tenant=`, which is what the transform's event rule matches, and
    // in the dataset mapConsent is registered for. A key the rule does not
    // match lands an object nothing reads.
    expect(key).toMatch(/^tenant=t1\/dataset=truelayer\.me\//);
  });

  it("writes the envelope the transform expects, not a shape of its own", async () => {
    // The transform reads these fields by name. A second format here is one
    // the reader does not know about and nothing would catch.
    const { deps: d, put } = landing();

    await reconfirmConnection(d, "t1", "cred-1", NOW);

    const body = JSON.parse(
      (await import("node:zlib")).gunzipSync(put.mock.calls[0]![1]).toString(),
    ) as Record<string, unknown>;
    expect(body["captureVersion"]).toBe(1);
    expect(body["endpoint"]).toBe("truelayer.me");
    expect(body["httpStatus"]).toBe(200);
    expect(body["accountId"]).toBeNull();
    expect(body["body"]).toMatchObject({ results: [{ credentials_id: "cred-1" }] });
  });

  it("still reports the renewal when landing fails", async () => {
    // The token is stored and the consent IS renewed. Reporting a failure here
    // would tell the household their renewal did not work when it did, and
    // the row catches up on the next sync regardless.
    const { deps: d, update } = landing({
      raw: {
        put: vi.fn(async (_k: string, _b: Buffer, _o: Record<string, unknown>) => {
          throw new Error("s3 is having a day");
        }),
      } as unknown as ConnectDeps["raw"],
    });

    await expect(reconfirmConnection(d, "t1", "cred-1", NOW)).resolves.toMatchObject({
      action: "renewed",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("renews without a bucket configured, and lands nothing", async () => {
    // A deployment with no raw bucket still renews; the row waits for the sync.
    const { deps: d, put } = landing({ raw: undefined });

    await expect(reconfirmConnection(d, "t1", "cred-1", NOW)).resolves.toMatchObject({
      action: "renewed",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("lands nothing when the provider sent somebody to a journey", async () => {
    // Nothing has been renewed yet, so writing a consent row would record a
    // renewal that has not happened.
    const { deps: d, put } = landing({
      truelayer: {
        refresh: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: vi.fn(async () => ({
          action: "authentication" as const,
          continueAt: "https://go.invalid/x",
        })),
      },
    } as unknown as Partial<ConnectDeps>);

    await reconfirmConnection(d, "t1", "cred-1", NOW);

    expect(put).not.toHaveBeenCalled();
  });
});
