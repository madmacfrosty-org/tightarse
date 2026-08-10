import { loadConfig, type AppConfig } from "./config";

/**
 * Authentication via Cognito's hosted UI, authorisation-code flow with PKCE.
 *
 * No SDK. The whole flow is two fetches and a redirect, and dropping the SRP
 * library removed a second code path as well as the bundle weight — password
 * sign-in and Google now take exactly the same route, so there is one thing to
 * reason about rather than two. The hosted UI also handles the first-login
 * password change, which previously needed its own screen here.
 *
 * PKCE rather than a client secret: a browser cannot keep a secret, and the
 * code verifier proves the app redeeming the code is the one that began the
 * flow.
 *
 * Tokens live in sessionStorage, so a session does not survive closing the
 * browser. This is bank data on a machine that may not be one person's.
 */

const STORE = {
  verifier: "tightarse.pkce_verifier",
  state: "tightarse.oauth_state",
  tokens: "tightarse.tokens",
} as const;

interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
}

export interface Identity {
  email: string;
  tenant: string;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomString(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(48)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Must match a registered callback exactly — no trailing slash, no query. */
function redirectUri(): string {
  return window.location.origin;
}

function readTokens(): Tokens | null {
  const raw = sessionStorage.getItem(STORE.tokens);
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

function claimsOf(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("Malformed ID token");
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

function identityFrom(idToken: string): Identity {
  const claims = claimsOf(idToken);
  const tenant = claims["custom:tenant"];
  if (typeof tenant !== "string" || tenant.length === 0) {
    // Fail rather than default. The claim is injected by a pre-token trigger
    // from an administrator-created membership record, so its absence means
    // "not a member of any household" — not "not set yet".
    throw new Error("This account has no household assigned.");
  }
  return { email: String(claims["email"] ?? ""), tenant };
}

/** Send the browser to the hosted UI. */
export async function signIn(): Promise<void> {
  const cfg = await loadConfig();
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(STORE.verifier, verifier);
  sessionStorage.setItem(STORE.state, state);

  const url = new URL(`https://${cfg.hostedUiDomain}/oauth2/authorize`);
  url.searchParams.set("client_id", cfg.userPoolClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
}

/**
 * Complete the redirect, if this page load is one. Returns null when there is
 * no code in the URL, so it is safe to call on every load.
 */
export async function completeSignIn(): Promise<Identity | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const returnedState = params.get("state");
  const error = params.get("error");

  if (error) {
    cleanUrl();
    throw new Error(params.get("error_description") ?? error);
  }
  if (!code) return null;

  const expectedState = sessionStorage.getItem(STORE.state);
  const verifier = sessionStorage.getItem(STORE.verifier);
  sessionStorage.removeItem(STORE.state);
  sessionStorage.removeItem(STORE.verifier);
  cleanUrl();

  // A mismatched state means the redirect did not originate here.
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("State mismatch — sign-in aborted.");
  }
  if (!verifier) throw new Error("Missing PKCE verifier — start sign-in again.");

  const cfg = await loadConfig();
  const tokens = await exchange(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  sessionStorage.setItem(STORE.tokens, JSON.stringify(tokens));
  return identityFrom(tokens.idToken);
}

export async function currentIdentity(): Promise<Identity | null> {
  const token = await idToken();
  if (!token) return null;
  try {
    return identityFrom(token);
  } catch {
    return null;
  }
}

/** A valid ID token, refreshed silently when needed. */
export async function idToken(): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;
  // Refresh a minute early rather than on the boundary, so a request already in
  // flight cannot arrive with a token that expired between check and send.
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.idToken;

  try {
    const cfg = await loadConfig();
    const refreshed = await exchange(cfg, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });
    // A refresh response omits the refresh token; keep the one we hold.
    const next = { ...refreshed, refreshToken: refreshed.refreshToken || tokens.refreshToken };
    sessionStorage.setItem(STORE.tokens, JSON.stringify(next));
    return next.idToken;
  } catch {
    sessionStorage.removeItem(STORE.tokens);
    return null;
  }
}

async function exchange(cfg: AppConfig, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`https://${cfg.hostedUiDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.userPoolClientId, ...params }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const body = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

export async function signOut(): Promise<void> {
  const cfg = await loadConfig();
  sessionStorage.removeItem(STORE.tokens);
  const url = new URL(`https://${cfg.hostedUiDomain}/logout`);
  url.searchParams.set("client_id", cfg.userPoolClientId);
  url.searchParams.set("logout_uri", redirectUri());
  window.location.assign(url.toString());
}

/** Strip the OAuth parameters so a page refresh cannot replay the callback. */
function cleanUrl(): void {
  window.history.replaceState({}, "", window.location.pathname);
}

/**
 * Fetch from the API with the ID token attached.
 *
 * The ID token, not the access token: only the ID token carries custom:tenant,
 * and the API returns 403 without it. Verified against the deployed API.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const cfg = await loadConfig();
  const token = await idToken();
  if (!token) throw new Error("Not signed in");
  const res = await fetch(`${cfg.apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw new Error("Not authorised for this household");
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}
