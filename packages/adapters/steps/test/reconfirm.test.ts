import { describe, it, expect, vi } from "vitest";
import {
  reconfirmConnection,
  connectionForConsent,
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
      // Returns the token it was given: no rotation, which is what the
      // sandbox does and what prod's banks were measured doing. Rotation is
      // the exception and is set up explicitly by the tests that are about it.
      refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
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

    const out = await reconfirmConnection(d, "t1", "cred-1");

    // No `expiresAt`: this `/me` stub does not report one, and the token
    // response's own expiry is an access-token lifetime. Saying nothing beats
    // dressing an hour up as a consent deadline.
    expect(out).toMatchObject({ action: "renewed" });
    expect(out.expiresAt).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      connectionId: "conn-1",
      refreshToken: "rt-new",
    });
    // NOT from the token response. `expires_in` there is the ACCESS token's
    // lifetime — about an hour — and writing it as the consent's expiry set
    // three prod connections to "lapsed an hour ago".
    expect(update.mock.calls[0]![0]).toMatchObject({
      consentExpiresAt: "2026-11-11T00:00:00.000Z",
    });
  });

  it("hands back a link when the provider wants a person, and stores nothing", async () => {
    // Nothing has changed at the provider yet, so writing anything here would
    // record a renewal that has not happened.
    const { deps: d, update } = deps({
      truelayer: {
        refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: vi.fn(async () => ({
          action: "authentication" as const,
          continueAt: "https://login.example.invalid/?session=1",
        })),
      },
    } as unknown as Partial<ConnectDeps>);

    const out = await reconfirmConnection(d, "t1", "cred-1");

    expect(out).toMatchObject({
      action: "authentication",
      continueAt: "https://login.example.invalid/?session=1",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("asks the provider even about a consent our record calls lapsed", async () => {
    // There was a guard here that refused on the stored date. It was wrong
    // twice: the provider is the authority on whether a consent can still be
    // extended, and it says so in the call with a reason — and a local copy
    // that drifts refuses renewals that would have worked. On 4 October 2026
    // it refused all three of prod's after a bug overwrote that field.
    const { deps: d, extendConnection } = deps({}, [
      connection({ consentExpiresAt: "2026-09-01T00:00:00.000Z" }),
    ]);

    await expect(reconfirmConnection(d, "t1", "cred-1")).resolves.toMatchObject({
      action: "renewed",
    });
    expect(extendConnection).toHaveBeenCalledTimes(1);
  });

  it("says so when no connection matches the consent", async () => {
    const { deps: d } = deps({}, [connection({ credentialsId: "other" })]);
    await expect(reconfirmConnection(d, "t1", "cred-1")).rejects.toBeInstanceOf(ConsentUnknown);
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

  it("passes a provider refusal through as 502 rather than guessing 409", async () => {
    // A consent the provider will not extend is the provider's answer, and
    // comes back with its status. Deciding that here from a stored date was
    // the bug that bricked renewal in prod.
    const { TrueLayerError } = await import("@tightarse/truelayer");
    const { deps: d } = deps({
      truelayer: {
        refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: vi.fn(async () => {
          throw new TrueLayerError("consent is gone", 422, "invalid_consent");
        }),
      },
    } as unknown as Partial<ConnectDeps>);

    expect((await call(d, { consentId: "cred-1" })).statusCode).toBe(502);
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
        refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
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
        refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
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
          refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
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
          refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
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
        refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
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

describe("a provider that rotates the refresh token", () => {
  /**
   * Neither the sandbox nor prod's banks were measured rotating, so none of
   * this has ever fired in anger. It is still the documented contract —
   * "TrueLayer may return a NEW refresh token, and the old one stops working"
   * — and the renewal path discarded it in two places. Against a provider
   * that does rotate, that loses the connection, and the symptom arrives days
   * later when the next sync fails.
   */
  const rotating = (stored: Connection[]) => {
    const rotate = vi.fn(async (rt: string) => ({
      accessToken: "at",
      refreshToken: `${rt}-rotated`,
      expiresAt: "x",
    }));
    const { deps: d, update } = deps(
      {
        truelayer: {
          refresh: rotate,
          get: vi.fn(async () => ({
            status: 200,
            body: { results: [{ credentials_id: "cred-1" }] },
          })),
          // Typed, so `mock.calls` carries the arguments the assertions read.
          extendConnection: vi.fn(
            async (_at: string, _args: { refreshToken: string }) => ({
              action: "renewed" as const,
              tokens: { accessToken: "a", refreshToken: "rt-final", expiresAt: "z" },
            }),
          ),
        },
      } as unknown as Partial<ConnectDeps>,
      stored,
    );
    return { deps: d, update, extend: (d.truelayer as unknown as {
      extendConnection: { mock: { calls: [string, { refreshToken: string }][] } };
    }).extendConnection };
  };

  it("stores a rotated token before doing anything that can fail", async () => {
    // The ordering is the whole point. Between the provider issuing a new
    // token and this storing it, a failure loses the connection.
    const { deps: d, update } = rotating([connection()]);

    await reconfirmConnection(d, "t1", "cred-1");

    expect(update.mock.calls[0]![0]).toMatchObject({
      refreshToken: "rt-original-rotated",
    });
  });

  it("hands the extend call the token that is now live, not the spent one", async () => {
    // The bug that would break renewal against a rotating provider: refresh
    // replaces the token, and passing the original asks the provider to
    // extend a connection identified by something it has just retired.
    const { deps: d, extend } = rotating([connection()]);

    await reconfirmConnection(d, "t1", "cred-1");

    expect(extend.mock.calls[0]![1]).toMatchObject({
      refreshToken: "rt-original-rotated",
    });
  });

  it("keeps a token rotated while probing for the connection", async () => {
    // `connectionForConsent` refreshes each unlinked connection to ask /me
    // who it is. That refresh rotates too, and the answer has to be kept or
    // the probe kills the connection it was only trying to identify.
    const { deps: d, update } = rotating([unlinked(connection())]);

    await connectionForConsent(d, "t1", "cred-1");

    const tokens = update.mock.calls.map((c) => (c[0] as Connection).refreshToken);
    expect(tokens).toContain("rt-original-rotated");
    expect(tokens).not.toContain("rt-original");
  });
});

describe("what the provider is told about the household", () => {
  it("sends the user object the reference asks for, not just an id", async () => {
    // We were sending `{ id }` alone where TrueLayer's reference lists id,
    // name and an email or phone. Unproven as the reason prod extended
    // nothing, but it is a real difference between what is asked for and what
    // was sent, and the mock bank may simply not care.
    const extend = vi.fn(async (_at: string, _args: { user: Record<string, unknown> }) => ({
      action: "renewed" as const,
      tokens: { accessToken: "a", refreshToken: "r", expiresAt: "z" },
    }));
    const { deps: d } = deps({
      contactEmail: "someone@example.invalid",
      truelayer: {
        refresh: vi.fn(async (rt: string) => ({ accessToken: "at", refreshToken: rt, expiresAt: "x" })),
        get: vi.fn(),
        extendConnection: extend,
      },
    } as unknown as Partial<ConnectDeps>);

    await reconfirmConnection(d, "t1", "cred-1");

    expect(extend.mock.calls[0]![1].user).toEqual({
      id: "t1",
      name: "t1",
      email: "someone@example.invalid",
    });
  });
});
