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
 * Falls back to Vite env vars so `npm run dev` works without deploying.
 */

export interface AppConfig {
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
}

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;

  const fromEnv: Partial<AppConfig> = {
    userPoolId: import.meta.env.VITE_USER_POOL_ID,
    userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    apiUrl: import.meta.env.VITE_API_URL,
  };
  if (fromEnv.userPoolId && fromEnv.userPoolClientId && fromEnv.apiUrl) {
    cached = fromEnv as AppConfig;
    return cached;
  }

  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load /config.json (${res.status})`);
  const json = (await res.json()) as Partial<AppConfig>;
  if (!json.userPoolId || !json.userPoolClientId || !json.apiUrl) {
    throw new Error("config.json is missing required fields");
  }
  cached = json as AppConfig;
  return cached;
}
