import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const FULL = {
  userPoolId: "eu-west-1_TEST",
  userPoolClientId: "client123",
  hostedUiDomain: "auth.example.com",
  apiUrl: "https://api.example.com",
};

/**
 * Both paths are exercised explicitly. Left to the ambient environment, which
 * branch runs depends on whether the developer happens to have a .env.local —
 * so coverage measured 80.1% locally and 79.02% in CI, and the threshold failed
 * the build on a machine difference rather than on a change.
 */
beforeEach(() => {
  vi.resetModules();
  for (const k of ["VITE_USER_POOL_ID", "VITE_USER_POOL_CLIENT_ID", "VITE_HOSTED_UI_DOMAIN", "VITE_API_URL"]) {
    vi.stubEnv(k, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("loadConfig", () => {
  it("prefers /config.json over a complete build-time environment", async () => {
    // The order this asserts is the whole point. A bundle built on a laptop
    // carries that laptop's .env.local, and prod was once served a bundle with
    // dev's pool, client id and hosted-UI domain baked in — sign-in went to
    // dev's hosted UI and died with redirect_mismatch. The deployed
    // config.json is the only one of the two that knows which environment is
    // actually being served, so it wins.
    vi.stubEnv("VITE_USER_POOL_ID", "eu-west-1_WRONG");
    vi.stubEnv("VITE_USER_POOL_CLIENT_ID", "wrong-client");
    vi.stubEnv("VITE_HOSTED_UI_DOMAIN", "wrong.auth.example.com");
    vi.stubEnv("VITE_API_URL", "https://wrong.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(FULL), { status: 200 })));

    const { loadConfig } = await import("../src/config");
    expect(await loadConfig()).toEqual(FULL);
  });

  it("uses build-time environment only when there is no config.json", async () => {
    // The dev server, which serves no config.json.
    vi.stubEnv("VITE_USER_POOL_ID", FULL.userPoolId);
    vi.stubEnv("VITE_USER_POOL_CLIENT_ID", FULL.userPoolClientId);
    vi.stubEnv("VITE_HOSTED_UI_DOMAIN", FULL.hostedUiDomain);
    vi.stubEnv("VITE_API_URL", FULL.apiUrl);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const { loadConfig } = await import("../src/config");
    expect(await loadConfig()).toEqual(FULL);
  });

  it("falls back to /config.json when the environment is incomplete", async () => {
    // One bundle serves every environment; baking values in would mean a dev
    // build and a prod build differing only in three strings.
    vi.stubEnv("VITE_USER_POOL_ID", FULL.userPoolId);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(FULL), { status: 200 })));

    const { loadConfig } = await import("../src/config");
    expect(await loadConfig()).toEqual(FULL);
  });

  it("caches, so a second call does not fetch again", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(FULL), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { loadConfig } = await import("../src/config");
    await loadConfig();
    await loadConfig();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("says which status it got when config.json cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { loadConfig } = await import("../src/config");
    await expect(loadConfig()).rejects.toThrow(/404/);
  });

  it("refuses a config.json missing any required field", async () => {
    // Half a config produces a sign-in that fails much later, somewhere else.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userPoolId: "x" }), { status: 200 })),
    );
    const { loadConfig } = await import("../src/config");
    await expect(loadConfig()).rejects.toThrow(/missing required fields/);
  });
});
