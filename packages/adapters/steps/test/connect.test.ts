import { describe, it, expect, vi } from "vitest";
import { authorisationUrl, completeConnect, connectRoutes, SCOPES, ALLOWED_PROVIDERS } from "../src/connect.js";

const deps = (over: Record<string, unknown> = {}) => {
  const created: unknown[] = [];
  // `truelayer` is merged rather than replaced, so a test naming one method
  // still gets a working exchangeCode. Everything else overrides outright.
  const { truelayer: truelayerOver, ...rest } = over;
  return {
    created,
    deps: {
      truelayer: {
        exchangeCode: vi.fn(async () => ({
          accessToken: "a",
          refreshToken: "the-refresh-token",
          expiresAt: new Date().toISOString(),
        })),
        ...(truelayerOver as object),
      },
      connections: { create: vi.fn(async (c: unknown) => created.push(c)) },
      redirectUri: "https://example.test/connect/callback",
      providers: "uk-ob-all",
      clientId: "cid",
      authBase: "https://auth.example.test",
      ...rest,
    } as never,
  };
};

describe("authorisationUrl", () => {
  it("requests offline_access, without which there is no refresh token", () => {
    // A consent whose token cannot be refreshed is a snapshot, not a
    // connection — which is exactly what the original probe produced.
    const url = authorisationUrl("cid", { redirectUri: "https://x.test/cb", providers: "uk-ob-all" }, "st");
    expect(new URL(url).searchParams.get("scope")).toContain("offline_access");
  });

  it("requests cards, because Amex offers nothing else", () => {
    expect(SCOPES).toContain("cards");
    const url = authorisationUrl("cid", { redirectUri: "https://x.test/cb", providers: "uk-ob-all" }, "st");
    expect(new URL(url).searchParams.get("scope")).toContain("cards");
  });

  it("carries state and the exact redirect URI", () => {
    const url = new URL(
      authorisationUrl("cid", { redirectUri: "https://x.test/cb", providers: "uk-ob-all" }, "st-123"),
    );
    expect(url.searchParams.get("state")).toBe("st-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(url.searchParams.get("client_id")).toBe("cid");
  });
});

describe("completeConnect", () => {
  it("stores the refresh token — the whole point of the flow", async () => {
    const { deps: d, created } = deps();
    await completeConnect(d, { tenantId: "frost", code: "abc" });
    expect((created[0] as { refreshToken: string }).refreshToken).toBe("the-refresh-token");
    expect((created[0] as { tenantId: string }).tenantId).toBe("frost");
  });

  it("records consent expiry as an absolute date, 90 days out", async () => {
    const { deps: d, created } = deps();
    const now = new Date("2026-08-10T00:00:00Z");
    const result = await completeConnect(d, { tenantId: "frost", code: "abc", now });
    expect(result.consentExpiresAt.slice(0, 10)).toBe("2026-11-08");
    expect((created[0] as { consentExpiresAt: string }).consentExpiresAt).toBe(result.consentExpiresAt);
  });

  it("does not fetch any data during the redirect", async () => {
    // Tempting, because the deep-history window is open right now — but a fetch
    // inside a redirect handler runs under a browser timeout, and losing it
    // half way would cost the consent. The scheduled sync does it instead.
    const get = vi.fn();
    const { deps: d } = deps({ truelayer: { get } });
    await completeConnect(d, { tenantId: "frost", code: "abc" });
    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * The routes themselves, which were unreachable while the handler built its own
 * Secrets Manager, TrueLayer and Step Functions clients. This is the flow that
 * costs a bank consent when it is wrong, and none of it had a test.
 */

const event = (over: Record<string, unknown> = {}) => ({
  rawPath: "/connect/start",
  queryStringParameters: {},
  requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "frost" } } } },
  ...over,
});

const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, string>;

describe("who may attach a bank connection", () => {
  it("refuses an identity with no household", async () => {
    // Otherwise anyone signed in could attach a bank connection to somebody
    // else's ledger, and the transactions would flow into it.
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ requestContext: { authorizer: { jwt: { claims: {} } } } }));
    expect(res.statusCode).toBe(403);
  });

  it("carries the household in state rather than trusting the callback", async () => {
    // The provider redirects the browser back with whatever it was given. The
    // tenant has to come from the signed claim at start time.
    const { deps: d } = deps();
    const res = await connectRoutes(d, event());
    expect(body(res)["state"]).toMatch(/^frost:/);
  });
});

describe("where the household is sent to authorise", () => {
  it("refuses a provider that is not on the allow-list", async () => {
    // `providers` steers where somebody types their bank credentials. It is not
    // a value to accept unchecked from a query string.
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ queryStringParameters: { provider: "evil-phishing-site" } }));
    expect(new URL(body(res)["url"]!).searchParams.get("providers")).toBe("uk-ob-all");
  });

  it("honours a provider that is on it", async () => {
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ queryStringParameters: { provider: ALLOWED_PROVIDERS[1] } }));
    expect(new URL(body(res)["url"]!).searchParams.get("providers")).toBe(ALLOWED_PROVIDERS[1]);
  });
});

describe("the callback, where the history is won or lost", () => {
  const callback = (over: Record<string, unknown> = {}) =>
    event({ rawPath: "/connect/callback", queryStringParameters: { code: "the-code" }, ...over });

  it("starts the first sync immediately, before the deep-history window shuts", async () => {
    // Roughly an hour after authorisation only 90 days remain available, for
    // ever. Leaving this to the daily schedule would silently cost five years
    // of history, visible only as charts that looked oddly short.
    const startSync = vi.fn(async () => {});
    const { deps: d } = deps({ startSync });
    const res = await connectRoutes(d, callback());
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startSync).toHaveBeenCalledWith(body(res)["connectionId"]);
  });

  it("stores the connection before starting the sync", async () => {
    // The state machine looks the connection up by id. Starting it first is a
    // race that fails the first sync — the one with the deep history in it.
    const order: string[] = [];
    const { deps: d } = deps({
      connections: { create: vi.fn(async () => void order.push("stored")) },
      startSync: vi.fn(async () => void order.push("sync-started")),
    });
    await connectRoutes(d, callback());
    expect(order).toEqual(["stored", "sync-started"]);
  });

  it("still returns the connection when no state machine is configured", async () => {
    // startSync is absent in an environment without one, and an optional call
    // must not turn into a 500 that loses the consent just granted.
    const { deps: d } = deps({ startSync: undefined });
    const res = await connectRoutes(d, callback());
    expect(res.statusCode).toBe(200);
    expect(body(res)["connectionId"]).toBeTruthy();
  });

  it("refuses a callback carrying no code", async () => {
    const { deps: d } = deps();
    const res = await connectRoutes(d, callback({ queryStringParameters: {} }));
    expect(res.statusCode).toBe(400);
  });

  it("reports the provider's own refusal rather than swallowing it", async () => {
    const { deps: d } = deps({ queryStringParameters: { error: "access_denied" } });
    const res = await connectRoutes(d, callback({ queryStringParameters: { error: "access_denied" } }));
    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toBe("access_denied");
  });

  it("does not start a sync when the exchange failed", async () => {
    // A failed exchange means there is no connection to sync, and starting one
    // would spend a provider call against a consent that does not exist.
    const startSync = vi.fn(async () => {});
    const { deps: d } = deps({
      truelayer: { exchangeCode: vi.fn(async () => { throw new Error("nope"); }) },
      startSync,
    });
    await expect(connectRoutes(d, callback())).rejects.toThrow();
    expect(startSync).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ rawPath: "/connect/nonsense" }));
    expect(res.statusCode).toBe(404);
  });
});

describe("which banks exist where", () => {
  // Written after dev sent somebody to First Direct against the sandbox. The
  // provider is real, so the allow-list accepted it; it does not exist in the
  // sandbox, so TrueLayer answered with a bare bad request after the redirect.
  const start = (sandbox: boolean, provider: string) => {
    // `sandbox` through the override rather than spread onto the result: the
    // helper's `deps` is a typed object literal, and spreading it loosens the
    // type enough that a missing field would go unnoticed.
    const { deps: d } = deps({ sandbox });
    return connectRoutes(d, event({ queryStringParameters: { provider } }));
  };

  it("refuses a real bank in the sandbox, naming what it can offer", async () => {
    const res = await start(true, "ob-first-direct");

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("uk-cs-mock");
  });

  it("refuses the mock bank in live, which has never heard of it", async () => {
    const res = await start(false, "uk-cs-mock");

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("ob-first-direct");
  });

  it("sends the mock bank through in the sandbox", async () => {
    const res = await start(true, "uk-cs-mock");

    expect(res.statusCode).toBe(200);
    expect(new URL(body(res)["url"]!).searchParams.get("providers")).toBe("uk-cs-mock");
  });

  it("still ignores a value that is not a provider, rather than reporting it", async () => {
    // Unchanged, and deliberately different from the two above: a hostile
    // value gets the default picker, not an error page confirming the attempt.
    const res = await start(true, "evil-phishing-site");

    expect(res.statusCode).toBe(200);
    expect(new URL(body(res)["url"]!).searchParams.get("providers")).toBe("uk-ob-all");
  });
});

describe("an event that is not shaped the way the gateway usually sends it", () => {
  // These branches were covered incidentally by the renewal tests, and lost
  // their cover when that capability was removed. They are worth their own
  // tests rather than their old accident: a handler that throws on a missing
  // field returns a 502 to somebody mid-authorisation, and the deep-history
  // window is open while they read it.
  it("answers a request with no path at all rather than throwing", async () => {
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ rawPath: undefined }));
    expect(res.statusCode).toBe(404);
  });

  it("treats absent query parameters as none given", async () => {
    // API Gateway omits the key entirely when there is no query string, rather
    // than sending an empty object.
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ queryStringParameters: undefined }));
    // The default picker, because no provider was asked for.
    expect(new URL(body(res)["url"]!).searchParams.get("providers")).toBe("uk-ob-all");
  });

  it("reports a provider refusing the code as a bad request, not a crash", async () => {
    // The authorisation code is single-use and short-lived, so this is a real
    // path: somebody who takes too long between the bank and the callback.
    // It must say so rather than 500, because the remedy is to start again.
    const { TrueLayerError } = await import("@tightarse/truelayer");
    const { deps: d } = deps({
      truelayer: {
        exchangeCode: vi.fn(async () => {
          throw new TrueLayerError("nope", 400, "invalid_grant");
        }),
      },
    });

    const res = await connectRoutes(
      d,
      event({ rawPath: "/connect/callback", queryStringParameters: { code: "spent" } }),
    );

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toMatch(/Provider rejected the code/);
  });
});

describe("suspending a connection over HTTP", () => {
  /*
   * Served by this function rather than the read API, because it writes the
   * connection secret and that holds a refresh token. Giving the read and
   * categorisation API those would widen it to every credential the household
   * has.
   */
  const suspendDeps = (over: Record<string, unknown> = {}) => {
    const rows = [
      {
        tenantId: "frost",
        consentId: "cred-1",
        provider: "truelayer",
        expiresAt: "2027-01-27T00:00:00.000Z",
        providerStatus: "Authorised",
        fetchedAt: "2026-10-30T05:00:00.000Z",
      },
    ];
    const put = vi.fn(async () => {});
    // Typed, so `mock.calls` carries the arguments the assertions read.
    const setSuspended = vi.fn(
      async (_tenantId: string, _credentialsId: string, _at: string | undefined) => true,
    );
    const { deps: d } = deps({
      consents: { list: vi.fn(async () => rows), put },
      connections: { setSuspended },
      ...over,
    });
    return { deps: d, put, setSuspended };
  };

  const post = (d: Parameters<typeof connectRoutes>[0], body: unknown) =>
    connectRoutes(d, event({ rawPath: "/v1/connections/suspend", body: JSON.stringify(body) }));

  it("stops the sync and records it", async () => {
    const { deps: d, put, setSuspended } = suspendDeps();

    const res = await post(d, { consentId: "cred-1", suspended: true });

    expect(res.statusCode).toBe(200);
    expect(setSuspended.mock.calls[0]?.slice(0, 2)).toEqual(["frost", "cred-1"]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("starts it again", async () => {
    const { deps: d, setSuspended } = suspendDeps();

    const res = await post(d, { consentId: "cred-1", suspended: false });

    expect(res.statusCode).toBe(200);
    // Resuming passes no date, which is what clears the mark.
    expect(setSuspended.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("asks for what it needs rather than failing obscurely", async () => {
    const { deps: d } = suspendDeps();
    expect((await post(d, { consentId: "cred-1" })).statusCode).toBe(400);
    expect((await post(d, "not json")).statusCode).toBe(400);
  });

  it("says 404 for a consent this household does not have", async () => {
    const { deps: d } = suspendDeps();
    expect((await post(d, { consentId: "someone-elses", suspended: true })).statusCode).toBe(404);
  });

  it("still marks the row when no connection carries the consent", async () => {
    // A consent row can outlive the connection behind it — the phantom this
    // was first built for. Refusing would leave it on the page for ever.
    const { deps: d, put } = suspendDeps({
      connections: {
        setSuspended: vi.fn(
          async (_t: string, _c: string, _at: string | undefined) => false,
        ),
      },
    });

    const res = await post(d, { consentId: "cred-1", suspended: true });

    expect(res.statusCode).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe("the shapes API Gateway actually sends a body in", () => {
  // Decided by the gateway rather than by the caller, so a handler that
  // ignores the flag works until the day the encoding changes under it.
  const withBody = (body: string, base64 = false) => {
    const { deps: d } = deps({
      consents: {
        list: vi.fn(async () => [
          {
            tenantId: "frost",
            consentId: "cred-1",
            provider: "truelayer",
            expiresAt: "2027-01-27T00:00:00.000Z",
            providerStatus: "Authorised",
            fetchedAt: "2026-10-30T05:00:00.000Z",
          },
        ]),
        put: vi.fn(async () => {}),
      },
      connections: {
        setSuspended: vi.fn(async (_t: string, _c: string, _at: string | undefined) => true),
      },
    });
    return connectRoutes(
      d,
      event({ rawPath: "/v1/connections/suspend", body, isBase64Encoded: base64 }),
    );
  };

  it("reads a base64 body", async () => {
    const json64 = Buffer.from(
      JSON.stringify({ consentId: "cred-1", suspended: true }),
      "utf8",
    ).toString("base64");

    expect((await withBody(json64, true)).statusCode).toBe(200);
  });

  it("treats a request with no body as a bad one", async () => {
    const { deps: d } = deps();
    const res = await connectRoutes(d, event({ rawPath: "/v1/connections/suspend" }));
    expect(res.statusCode).toBe(400);
  });

  it("reports a provider refusal that carries no error code", async () => {
    // TrueLayerError takes a null code, and a template assuming a string
    // would print "undefined" into the message somebody reads.
    const { TrueLayerError } = await import("@tightarse/truelayer");
    const { deps: d } = deps({
      truelayer: {
        exchangeCode: vi.fn(async () => {
          throw new TrueLayerError("nope", 400, null);
        }),
      },
    });

    const res = await connectRoutes(
      d,
      event({ rawPath: "/connect/callback", queryStringParameters: { code: "spent" } }),
    );

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).not.toContain("undefined");
  });
});

describe("removing a connection over HTTP", () => {
  const rows = (over: Record<string, unknown> = {}) => [
    {
      tenantId: "frost",
      consentId: "cred-1",
      provider: "truelayer",
      expiresAt: "2027-01-27T00:00:00.000Z",
      providerStatus: "Authorised",
      fetchedAt: "2026-10-31T05:00:00.000Z",
      ...over,
    },
  ];

  const removeDeps = (consentOver: Record<string, unknown> = {}) => {
    const put = vi.fn(async () => {});
    const deleteForConsent = vi.fn(async (_t: string, _c: string) => 1);
    const { deps: d } = deps({
      consents: { list: vi.fn(async () => rows(consentOver)), put },
      connections: { deleteForConsent },
    });
    return { deps: d, put, deleteForConsent };
  };

  const post = (d: Parameters<typeof connectRoutes>[0], body: unknown) =>
    connectRoutes(d, event({ rawPath: "/v1/connections/remove", body: JSON.stringify(body) }));

  it("deletes the credential of a suspended connection", async () => {
    const { deps: d, deleteForConsent, put } = removeDeps({
      suspendedAt: "2026-10-30T12:00:00.000Z",
    });

    const res = await post(d, { consentId: "cred-1" });

    expect(res.statusCode).toBe(200);
    expect(deleteForConsent).toHaveBeenCalledWith("frost", "cred-1");
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("refuses one that was never suspended, with 409 and the reason", async () => {
    const { deps: d, deleteForConsent } = removeDeps();

    const res = await post(d, { consentId: "cred-1" });

    expect(res.statusCode).toBe(409);
    expect(body(res)["error"]).toMatch(/Suspend this connection before removing/);
    expect(deleteForConsent).not.toHaveBeenCalled();
  });

  it("says 404 for a consent this household does not have", async () => {
    const { deps: d } = removeDeps({ suspendedAt: "2026-10-30T12:00:00.000Z" });
    expect((await post(d, { consentId: "someone-elses" })).statusCode).toBe(404);
  });

  it("asks for a consentId rather than failing obscurely", async () => {
    const { deps: d } = removeDeps();
    expect((await post(d, {})).statusCode).toBe(400);
  });
});
