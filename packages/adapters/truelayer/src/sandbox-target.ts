import { SANDBOX, type Credentials, type TrueLayerEnvironment } from "./index.js";

/**
 * Where an integration test against the provider is allowed to point.
 *
 * A decision rather than plumbing, so it lives apart from the suite that acts
 * on it and is tested directly — the same arrangement, and for the same
 * reason, as `resolveTestTarget` in the DynamoDB adapter.
 *
 * The hazard is worse here than a stray row. `TrueLayerClient.refresh` spends a
 * refresh token and the provider may return a new one, invalidating the old:
 * "keeping the original is how a connection silently dies days later". Prod
 * holds the household's connections, so a suite that reached live TrueLayer
 * with prod's stored token would leave prod holding a spent one — the failure
 * ADR-0003 and #43 are both about, which surfaces days later as a dead
 * connection and cannot be undone without the household re-authorising at the
 * bank. Data calls would also spend the unattended allowance, which is four per
 * account, endpoint and consent per 24 hours.
 *
 * So the environment is not a parameter. `SANDBOX` is returned always and
 * `LIVE` cannot be asked for, which makes "this suite cannot reach the
 * household's connections" a property of the type rather than of how carefully
 * somebody set their shell.
 */

/** The variables that carry a sandbox credential. Named so live values do not fit. */
export interface SandboxEnv {
  readonly TL_SANDBOX_CLIENT_ID?: string | undefined;
  readonly TL_SANDBOX_CLIENT_SECRET?: string | undefined;
  readonly TL_SANDBOX_REFRESH_TOKEN?: string | undefined;
  readonly TL_ENV?: string | undefined;
}

export interface SandboxTarget {
  readonly credentials: Credentials;
  /** Always the sandbox. Present so callers construct a client from it rather
   *  than reaching for a constant and getting the wrong one. */
  readonly environment: TrueLayerEnvironment;
  /**
   * A consent to refresh, when one has been minted.
   *
   * Absent is the normal state: obtaining it needs one interactive
   * authorisation at the mock bank, and everything not about refreshing runs
   * without it.
   */
  readonly refreshToken?: string;
}

/**
 * Resolve a target, or throw explaining which rule was broken.
 *
 * There is no default credential, for the reason the DynamoDB gate has no
 * default table: a default is what makes the unsafe path the one that happens
 * when you set nothing.
 */
export function resolveSandboxTarget(env: SandboxEnv): SandboxTarget {
  // Checked first, and checked at all, because `TL_ENV=live` is a plausible
  // thing to have exported for an unrelated reason — running the sync steps by
  // hand, say. Refusing beats quietly ignoring it: somebody who set it believes
  // it is being honoured, and silently overriding is how the next person learns
  // it does not mean what they thought.
  if (env.TL_ENV !== undefined && env.TL_ENV !== "sandbox") {
    throw new Error(
      `Refusing to run against TL_ENV=${env.TL_ENV}. These tests spend refresh ` +
        `tokens and data-call allowance, and the connections that matter are ` +
        `prod's. Unset it or set it to "sandbox".`,
    );
  }

  const clientId = env.TL_SANDBOX_CLIENT_ID;
  const clientSecret = env.TL_SANDBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "TL_SANDBOX_CLIENT_ID and TL_SANDBOX_CLIENT_SECRET are not both set. There " +
        "is no default: a default would be a live credential the moment one was " +
        "to hand.",
    );
  }

  return {
    credentials: { clientId, clientSecret },
    environment: SANDBOX,
    ...(env.TL_SANDBOX_REFRESH_TOKEN ? { refreshToken: env.TL_SANDBOX_REFRESH_TOKEN } : {}),
  };
}

/**
 * Whether a credential is configured at all, without throwing.
 *
 * The suite needs this to decide between running and skipping, and a throw is
 * the wrong shape for that: an unconfigured machine should skip, while a
 * half-configured or dangerously configured one should fail loudly. So this
 * answers only "was anything asked for", and `resolveSandboxTarget` then
 * decides whether what was asked for is allowed.
 */
export function sandboxConfigured(env: SandboxEnv): boolean {
  return Boolean(env.TL_SANDBOX_CLIENT_ID ?? env.TL_SANDBOX_CLIENT_SECRET);
}
