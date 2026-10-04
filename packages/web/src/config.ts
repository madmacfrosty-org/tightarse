/**
 * Runtime configuration.
 *
 * Fetched from `/config.json` at boot rather than baked in at build time, so
 * one bundle works in every environment. Baking it in would mean a dev build
 * and a prod build that differ only in three strings, and the wrong one being
 * deployed is a mistake nobody notices until it points at the wrong ledger.
 *
 * None of these are secret. A Cognito pool id, client id and API URL are public
 * identifiers — the pool and the JWT authoriser are what enforce access.
 *
 * `/config.json` wins whenever it exists. Vite env vars are the fallback, for
 * `npm run dev` against a deployed backend and nothing else.
 *
 * That order matters and was once the other way round. Build-time variables come
 * from whatever `.env.local` sat on the machine that ran the build, which is a
 * fact about a laptop rather than about a deployment — so prod shipped a bundle
 * with dev's pool, client id and hosted-UI domain baked in, and the correct
 * config.json deployed beside it was never read. Sign-in went to dev's hosted UI
 * and failed with `redirect_mismatch`, which is the only reason it was noticed:
 * had dev's client allowed the prod callback, the prod dashboard would have
 * authenticated against dev's pool and shown dev's ledger.
 */

export interface AppConfig {
  userPoolId: string;
  userPoolClientId: string;
  /** Cognito hosted-UI domain, without scheme. */
  hostedUiDomain: string;
  apiUrl: string;
  /**
   * Whether this deployment may renew a consent.
   *
   * A permission rather than an environment name, so the page is not deriving
   * policy from which provider is behind it — that is how a dashboard ends up
   * encoding a rule the API owns, and the two drift the first time one moves.
   *
   * Optional, and absent means no. A page served by a deployment that predates
   * this field cannot know, and offering an action that then fails is worse
   * than not offering it.
   */
  canRenewConnections?: boolean;
  /**
   * Which TrueLayer is behind this deployment.
   *
   * Separate from `canRenewConnections`, and a different kind of fact. That
   * one is a permission the API owns and the page must not second-guess; this
   * is which catalogue of banks exists, which the page legitimately knows —
   * sandbox holds a mock and none of the real ones.
   *
   * Absent means live, because a deployment predating this field is one.
   */
  providerEnvironment?: "sandbox" | "live";
}

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;

  const res = await fetch("/config.json", { cache: "no-store" });
  if (res.ok) {
    const json = (await res.json()) as Partial<AppConfig>;
    if (!json.userPoolId || !json.userPoolClientId || !json.hostedUiDomain || !json.apiUrl) {
      throw new Error("config.json is missing required fields");
    }
    cached = json as AppConfig;
    return cached;
  }

  // No config.json: a dev server, where the values come from .env.local.
  const fromEnv: Partial<AppConfig> = {
    userPoolId: import.meta.env.VITE_USER_POOL_ID,
    userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    hostedUiDomain: import.meta.env.VITE_HOSTED_UI_DOMAIN,
    apiUrl: import.meta.env.VITE_API_URL,
    ...(import.meta.env.VITE_CAN_RENEW_CONNECTIONS === "true"
      ? { canRenewConnections: true }
      : {}),
    ...(import.meta.env.VITE_PROVIDER_ENVIRONMENT === "sandbox"
      ? { providerEnvironment: "sandbox" as const }
      : {}),
  };
  if (fromEnv.userPoolId && fromEnv.userPoolClientId && fromEnv.hostedUiDomain && fromEnv.apiUrl) {
    cached = fromEnv as AppConfig;
    return cached;
  }

  throw new Error(`Could not load /config.json (${res.status})`);
}
