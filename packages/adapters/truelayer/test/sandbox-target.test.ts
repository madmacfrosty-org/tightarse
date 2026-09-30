import { describe, it, expect } from "vitest";
import {
  resolveSandboxTarget,
  sandboxConfigured,
  type SandboxEnv,
} from "../src/sandbox-target.js";
import { LIVE, SANDBOX } from "../src/index.js";

/**
 * The gate on the integration suite, tested where it always runs.
 *
 * Deliberately not inside that suite: it would then be exercised only on a
 * machine holding a credential, which is the one machine where being wrong
 * costs something. Ten DynamoDB tests once skipped silently on every push for
 * weeks — a green tick meaning nothing — and a safety check that skips with its
 * suite has the same shape.
 *
 * Every value below is invented. This repository is public.
 */
const env = (over: Partial<SandboxEnv> = {}): SandboxEnv => ({
  TL_SANDBOX_CLIENT_ID: "sandbox-id",
  TL_SANDBOX_CLIENT_SECRET: "sandbox-secret",
  ...over,
});

describe("where a provider integration test may point", () => {
  it("returns the sandbox, and offers no way to ask for live", () => {
    // The property worth stating: the environment is not an input. A suite that
    // could be pointed at live could rotate the refresh token prod is holding,
    // and the connection dies days later with no way back but re-authorising.
    const target = resolveSandboxTarget(env());

    expect(target.environment).toEqual(SANDBOX);
    expect(target.environment.api).not.toEqual(LIVE.api);
    expect(target.environment.auth).not.toEqual(LIVE.auth);
  });

  it("refuses when the shell says live, rather than quietly overriding it", () => {
    // Somebody who exported TL_ENV=live believes it is being honoured. Ignoring
    // it silently works until the day it does not mean what they assumed.
    expect(() => resolveSandboxTarget(env({ TL_ENV: "live" }))).toThrow(/Refusing/);
  });

  it("accepts an explicit sandbox, because agreeing is not a conflict", () => {
    expect(() => resolveSandboxTarget(env({ TL_ENV: "sandbox" }))).not.toThrow();
  });

  it("refuses a credential given only half, rather than falling back", () => {
    // Half-configured is the state a default would paper over, and the thing it
    // would fall back to is whatever live credential happened to be around.
    expect(() =>
      resolveSandboxTarget({ TL_SANDBOX_CLIENT_ID: "sandbox-id" }),
    ).toThrow(/no default/i);
    expect(() =>
      resolveSandboxTarget({ TL_SANDBOX_CLIENT_SECRET: "sandbox-secret" }),
    ).toThrow(/no default/i);
  });

  it("carries a refresh token only when one was minted", () => {
    // Absent is the normal state: minting one needs an interactive
    // authorisation, and everything not about refreshing runs without it.
    expect(resolveSandboxTarget(env()).refreshToken).toBeUndefined();
    expect(
      resolveSandboxTarget(env({ TL_SANDBOX_REFRESH_TOKEN: "rt" })).refreshToken,
    ).toBe("rt");
  });

  it("separates 'nothing configured' from 'configured wrongly'", () => {
    // The suite skips on the first and must fail on the second. Collapsing them
    // into one answer makes a dangerous configuration look like an absent one.
    expect(sandboxConfigured({})).toBe(false);
    expect(sandboxConfigured(env())).toBe(true);
    expect(sandboxConfigured({ TL_SANDBOX_CLIENT_ID: "sandbox-id" })).toBe(true);
    expect(() => resolveSandboxTarget({ TL_SANDBOX_CLIENT_ID: "sandbox-id" })).toThrow();
  });
});
