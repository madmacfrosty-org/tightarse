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
  };
  if (fromEnv.userPoolId && fromEnv.userPoolClientId && fromEnv.hostedUiDomain && fromEnv.apiUrl) {
    cached = fromEnv as AppConfig;
    return cached;
  }

  throw new Error(`Could not load /config.json (${res.status})`);
}
