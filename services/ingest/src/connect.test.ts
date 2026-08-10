import { describe, it, expect, vi } from "vitest";
import { authorisationUrl, completeConnect, SCOPES } from "./connect.js";

const deps = (over: Record<string, unknown> = {}) => {
  const created: unknown[] = [];
  return {
    created,
    deps: {
      truelayer: {
        exchangeCode: vi.fn(async () => ({
          accessToken: "a",
          refreshToken: "the-refresh-token",
          expiresAt: new Date().toISOString(),
        })),
        ...(over["truelayer"] as object),
      },
      connections: { create: vi.fn(async (c: unknown) => created.push(c)) },
      redirectUri: "https://example.test/connect/callback",
      providers: "uk-ob-all",
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
