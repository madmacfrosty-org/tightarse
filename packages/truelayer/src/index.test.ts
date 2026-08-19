import { describe, it, expect, vi, afterEach } from "vitest";
import { TrueLayerClient, TrueLayerError, historyFrom, LIVE, MAX_HISTORY_MONTHS, SANDBOX } from "./index.js";

const creds = { clientId: "id", clientSecret: "secret" };

const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })));

/** Records what was actually requested, so the URL and headers can be asserted. */
function recordingFetch(status: number, body: unknown) {
  const calls: Array<{
    url: string;
    init: { method?: string; headers?: Record<string, string>; body?: unknown } | undefined;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: never) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("token handling", () => {
  it("returns an absolute expiry, so a stored token can be judged later", async () => {
    mockFetch(200, { access_token: "a", refresh_token: "r", expires_in: 3600 });
    const t = await new TrueLayerClient(creds, SANDBOX).refresh("old");
    expect(t.accessToken).toBe("a");
    expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("surfaces a rotated refresh token", async () => {
    // TrueLayer may return a NEW refresh token and invalidate the old one.
    // Keeping the original is how a connection silently dies days later.
    mockFetch(200, { access_token: "a", refresh_token: "rotated", expires_in: 3600 });
    const t = await new TrueLayerClient(creds, SANDBOX).refresh("original");
    expect(t.refreshToken).toBe("rotated");
  });

  it("fails loudly when no refresh token comes back", async () => {
    mockFetch(200, { access_token: "a", expires_in: 3600 });
    await expect(new TrueLayerClient(creds, SANDBOX).refresh("r")).rejects.toThrow(/offline_access/);
  });
});

describe("error classification", () => {
  it("identifies a lapsed consent, which a human must fix", async () => {
    mockFetch(400, { error: "invalid_grant" });
    try {
      await new TrueLayerClient(creds, SANDBOX).refresh("stale");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TrueLayerError);
      expect((e as TrueLayerError).isConsentExpired).toBe(true);
    }
  });

  it("treats 501 and 403 as not-applicable rather than failure", () => {
    // First Direct returns 501 for standing orders on every account and 403 for
    // direct debits on accounts that have none. Retrying either is pointless.
    expect(new TrueLayerError("x", 501, "endpoint_not_supported").isNotApplicable).toBe(true);
    expect(new TrueLayerError("x", 403, "access_denied").isNotApplicable).toBe(true);
    expect(new TrueLayerError("x", 500, null).isNotApplicable).toBe(false);
  });
});

describe("history window", () => {
  it("caps at the measured provider limit", () => {
    // 72 months and beyond return invalid_date_range instantly; 60 works.
    expect(MAX_HISTORY_MONTHS).toBe(60);
  });

  it("clamps month-end instead of overflowing into the next month", () => {
    // setMonth alone turns "one month before 31 March" into 3 March, because
    // 31 February rolls forward — a silent three-day gap in the fetch window.
    expect(historyFrom(1, new Date("2026-03-31T00:00:00Z"))).toBe("2026-02-28");
    expect(historyFrom(1, new Date("2024-03-31T00:00:00Z"))).toBe("2024-02-29");
    expect(historyFrom(60, new Date("2026-08-10T00:00:00Z"))).toBe("2021-08-10");
    expect(historyFrom(60, new Date("2026-03-31T00:00:00Z"))).toBe("2021-03-31");
  });
});

describe("call counting", () => {
  const client = () =>
    new TrueLayerClient({ clientId: "id", clientSecret: "secret" }, SANDBOX);

  it("counts a data call even when it fails", async () => {
    // The provider charges the attempt against the allowance whatever it
    // returns, so counting successes would understate what was spent — and the
    // whole point of the metric is to see the cap coming.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    const c = client();
    await expect(c.get("token", "/data/v1/accounts")).rejects.toThrow();
    expect(c.calls).toBe(1);
  });

  it("accumulates across calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const c = client();
    await c.get("t", "/data/v1/accounts");
    await c.get("t", "/data/v1/cards");
    expect(c.calls).toBe(2);
  });

  it("does not count a token refresh", async () => {
    // A refresh is not a data call and does not count against the cap.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), { status: 200 }),
      ),
    );
    const c = client();
    await c.refresh("refresh-token");
    expect(c.calls).toBe(0);
  });
});

describe("the data request itself", () => {
  it("addresses the configured environment, not a hardcoded host", async () => {
    // LIVE and SANDBOX exist so a test run cannot reach real accounts. A client
    // that ignored its environment would send sandbox traffic to production.
    const calls = recordingFetch(200, { results: [] });
    await new TrueLayerClient(creds, SANDBOX).get("token", "/data/v1/accounts");
    expect(calls[0]!.url).toBe(`${SANDBOX.api}/data/v1/accounts`);
    expect(SANDBOX.api).not.toBe(LIVE.api);
  });

  it("sends the access token as a bearer credential", async () => {
    // Without this the call is anonymous and returns 401, which the step reads
    // as a lapsed consent and reports to a human who has nothing to fix.
    const calls = recordingFetch(200, { results: [] });
    await new TrueLayerClient(creds, SANDBOX).get("the-token", "/data/v1/cards");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer the-token" });
  });

  it("returns the status alongside the body", async () => {
    // The caller distinguishes 200 from 204 — an account with no transactions is
    // not the same as one we failed to read.
    mockFetch(200, { results: [1, 2] });
    const res = await new TrueLayerClient(creds, SANDBOX).get("t", "/data/v1/accounts");
    expect(res).toEqual({ status: 200, body: { results: [1, 2] } });
  });

  it("carries the provider's error code out of a failed call", async () => {
    // `isNotApplicable` and `isConsentExpired` are decided from status and code.
    // Losing the code turns a skippable endpoint into a failed sync.
    mockFetch(403, { error: "endpoint_not_supported" });
    await expect(new TrueLayerClient(creds, SANDBOX).get("t", "/data/v1/direct_debits")).rejects.toMatchObject({
      status: 403,
      code: "endpoint_not_supported",
    });
  });

  it("still fails cleanly when the error body is not JSON", async () => {
    // A gateway timeout returns HTML. Letting the parse throw would replace a
    // 504 anyone can act on with a SyntaxError nobody can.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 504,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })));
    await expect(new TrueLayerClient(creds, SANDBOX).get("t", "/data/v1/accounts")).rejects.toBeInstanceOf(
      TrueLayerError,
    );
  });

  it("counts a failed call against the allowance, exactly as the provider does", async () => {
    // Unattended access is four calls per account, endpoint and consent per 24
    // hours. Counting only successes is how a retry loop spends the allowance
    // and reports having used none.
    mockFetch(500, { error: "internal" });
    const client = new TrueLayerClient(creds, SANDBOX);
    await expect(client.get("t", "/data/v1/accounts")).rejects.toThrow();
    expect(client.calls).toBe(1);
  });
});

describe("exchanging an authorisation code", () => {
  it("posts the code and redirect against the auth host, form encoded", async () => {
    // A mismatch between the redirect_uri here and the one the bank was given
    // fails the exchange, and the consent is spent — deep history with it.
    const calls = recordingFetch(200, { access_token: "a", refresh_token: "r", expires_in: 3600 });
    await new TrueLayerClient(creds, SANDBOX).exchangeCode("the-code", "https://app/callback");
    expect(calls[0]!.url).toBe(`${SANDBOX.auth}/connect/token`);
    expect(calls[0]!.init?.method).toBe("POST");
    const sent = new URLSearchParams(String(calls[0]!.init?.body));
    expect(Object.fromEntries(sent)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://app/callback",
      client_id: "id",
    });
  });

  it("asks for a refresh, not an exchange, when refreshing", async () => {
    const calls = recordingFetch(200, { access_token: "a", refresh_token: "r", expires_in: 3600 });
    await new TrueLayerClient(creds, SANDBOX).refresh("old-token");
    const sent = new URLSearchParams(String(calls[0]!.init?.body));
    expect(Object.fromEntries(sent)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-token",
    });
  });

  it("defaults the expiry when the provider omits expires_in", async () => {
    // An absent expiry read as 0 would make every stored token instantly stale
    // and trigger a refresh on every single call.
    mockFetch(200, { access_token: "a", refresh_token: "r" });
    const t = await new TrueLayerClient(creds, SANDBOX).refresh("r");
    expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now() + 3_000_000);
  });
});
