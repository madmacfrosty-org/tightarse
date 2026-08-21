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
