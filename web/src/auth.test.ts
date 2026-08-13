import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const CONFIG = {
  userPoolId: "eu-west-1_TEST",
  userPoolClientId: "client123",
  hostedUiDomain: "auth.example.com",
  apiUrl: "https://api.example.com",
};

/** A JWT with the given claims. Only the payload is ever read. */
function token(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

const STORE = {
  state: "tightarse.oauth_state",
  verifier: "tightarse.pkce_verifier",
  tokens: "tightarse.tokens",
};

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(CONFIG), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("completeSignIn", () => {
  it("ignores a callback on any path but the root", async () => {
    // The bank connection flow also returns with ?code=. This used to claim it
    // and strip the URL, so a successful Amex authorisation presented as "no
    // authorisation code in the redirect".
    window.history.replaceState({}, "", "/connected?code=abc&state=xyz");
    sessionStorage.setItem(STORE.state, "xyz");

    const { completeSignIn } = await import("./auth");
    expect(await completeSignIn()).toBeNull();
    // And it must leave the query string alone for the connect page to read.
    expect(window.location.search).toContain("code=abc");
  });

  it("ignores a callback when no sign-in was started from this browser", async () => {
    // Second guard: only our flow leaves a PKCE state behind.
    window.history.replaceState({}, "", "/?code=abc&state=xyz");
    const { completeSignIn } = await import("./auth");
    expect(await completeSignIn()).toBeNull();
  });

  it("returns null on an ordinary page load", async () => {
    sessionStorage.setItem(STORE.state, "xyz");
    const { completeSignIn } = await import("./auth");
    expect(await completeSignIn()).toBeNull();
  });

  it("refuses a state that does not match the one it issued", async () => {
    // Cross-site request forgery on the callback.
    window.history.replaceState({}, "", "/?code=abc&state=WRONG");
    sessionStorage.setItem(STORE.state, "xyz");
    sessionStorage.setItem(STORE.verifier, "v");
    const { completeSignIn } = await import("./auth");
    await expect(completeSignIn()).rejects.toThrow();
  });
});

describe("currentIdentity", () => {
  const future = () => Date.now() + 10 * 60_000;

  it("reads email and household from the id token", async () => {
    sessionStorage.setItem(
      STORE.tokens,
      JSON.stringify({
        idToken: token({ email: "someone@example.com", "custom:tenant": "frost" }),
        accessToken: "a",
        refreshToken: "r",
        expiresAt: future(),
      }),
    );
    const { currentIdentity } = await import("./auth");
    expect(await currentIdentity()).toEqual({ email: "someone@example.com", tenant: "frost" });
  });

  it("treats a token with no household as not signed in, rather than defaulting", async () => {
    // Fail closed. A default here would put someone in a household they are
    // not a member of, which is the entire authorisation model.
    sessionStorage.setItem(
      STORE.tokens,
      JSON.stringify({
        idToken: token({ email: "stranger@example.com" }),
        accessToken: "a",
        refreshToken: "r",
        expiresAt: future(),
      }),
    );
    const { currentIdentity } = await import("./auth");
    expect(await currentIdentity()).toBeNull();
  });

  it("returns null when nothing is stored", async () => {
    const { currentIdentity } = await import("./auth");
    expect(await currentIdentity()).toBeNull();
  });
});

describe("idToken", () => {
  it("uses a token that is still comfortably valid", async () => {
    const t = token({ email: "a@b.com", "custom:tenant": "frost" });
    sessionStorage.setItem(
      STORE.tokens,
      JSON.stringify({ idToken: t, accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 600_000 }),
    );
    const { idToken } = await import("./auth");
    expect(await idToken()).toBe(t);
  });

  it("refreshes a token inside the last minute of its life", async () => {
    // Refreshing early matters: a request already in flight must not arrive
    // with a token that expired between the check and the send.
    const fresh = token({ email: "a@b.com", "custom:tenant": "frost" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/oauth2/token")
          ? new Response(
              JSON.stringify({ id_token: fresh, access_token: "a2", expires_in: 3600 }),
              { status: 200 },
            )
          : new Response(JSON.stringify(CONFIG), { status: 200 }),
      ),
    );
    sessionStorage.setItem(
      STORE.tokens,
      JSON.stringify({ idToken: "stale", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 30_000 }),
    );
    const { idToken } = await import("./auth");
    expect(await idToken()).toBe(fresh);
  });

  it("keeps the refresh token when the response omits it", async () => {
    // A refresh response does not return one; discarding it would end the
    // session at the next refresh.
    const fresh = token({ email: "a@b.com", "custom:tenant": "frost" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/oauth2/token")
          ? new Response(JSON.stringify({ id_token: fresh, access_token: "a2", expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify(CONFIG), { status: 200 }),
      ),
    );
    sessionStorage.setItem(
      STORE.tokens,
      JSON.stringify({ idToken: "stale", accessToken: "a", refreshToken: "keep-me", expiresAt: Date.now() + 30_000 }),
    );
    const { idToken } = await import("./auth");
    await idToken();
    expect(JSON.parse(sessionStorage.getItem(STORE.tokens)!).refreshToken).toBe("keep-me");
  });

  it("drops the session when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/oauth2/token")
          ? new Response("no", { status: 400 })
          : new Response(JSON.stringify(CONFIG), { status: 200 }),
      ),
    );
    sessionStorage.setItem(
      STORE.tokens,
      JSON.stringify({ idToken: "stale", accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1 }),
    );
    const { idToken } = await import("./auth");
    expect(await idToken()).toBeNull();
    expect(sessionStorage.getItem(STORE.tokens)).toBeNull();
  });
});
