import { loadConfig } from "./config";
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";

/**
 * Cognito authentication for the dashboard.
 *
 * SRP, so the password is never transmitted — only a proof of knowledge.
 *
 * The API is sent the **ID token**, not the access token. Only the ID token
 * carries `custom:tenant`, and that claim is the entire access-control model:
 * a correctly-signed access token from the right pool is rejected by the API
 * with 403 because it cannot say which household it speaks for. Verified
 * against the deployed API.
 *
 * Tokens are kept in sessionStorage rather than the library's default
 * localStorage, so a session does not survive closing the browser. This is bank
 * data on a machine that may not be the only person's.
 */

let pool: CognitoUserPool | null = null;
let apiUrl = "/api";

/** Must be awaited once before anything else here is used. */
export async function initAuth(): Promise<void> {
  const cfg = await loadConfig();
  apiUrl = cfg.apiUrl;
  pool = new CognitoUserPool({
    UserPoolId: cfg.userPoolId,
    ClientId: cfg.userPoolClientId,
    // The library defaults to localStorage, which survives a browser restart.
    // Bank data on a machine someone else might use should not.
    Storage: window.sessionStorage,
  });
}

export interface Identity {
  email: string;
  tenant: string;
}

function identityFrom(session: CognitoUserSession): Identity {
  const claims = session.getIdToken().decodePayload() as Record<string, unknown>;
  const tenant = claims["custom:tenant"];
  if (typeof tenant !== "string" || tenant.length === 0) {
    // Fail rather than default. An identity with no household must not silently
    // fall back to one — that is how someone ends up reading another family's
    // ledger.
    throw new Error("This account has no household assigned.");
  }
  return { email: String(claims["email"] ?? ""), tenant };
}

export async function signIn(email: string, password: string): Promise<Identity> {
  if (!pool) throw new Error("Cognito is not configured");
  const user = new CognitoUser({ Username: email, Pool: pool });
  const session = await new Promise<CognitoUserSession>((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: resolve,
      onFailure: reject,
      newPasswordRequired: () =>
        reject(new Error("A new password is required — set one in the Cognito console first.")),
    });
  });
  return identityFrom(session);
}

/** The current session, refreshed if the token has expired. */
export async function currentIdentity(): Promise<Identity | null> {
  if (!pool) return null;
  const user = pool.getCurrentUser();
  if (!user) return null;
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) return resolve(null);
      try {
        resolve(identityFrom(session));
      } catch {
        resolve(null);
      }
    });
  });
}

/** A valid ID token, refreshing silently when the current one has expired. */
export async function idToken(): Promise<string | null> {
  if (!pool) return null;
  const user = pool.getCurrentUser();
  if (!user) return null;
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      resolve(err || !session?.isValid() ? null : session.getIdToken().getJwtToken());
    });
  });
}

export function signOut(): void {
  pool?.getCurrentUser()?.signOut();
}

/** Fetch from the API with the ID token attached. */
export async function apiGet<T>(path: string): Promise<T> {
  const token = await idToken();
  if (!token) throw new Error("Not signed in");
  const res = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Not authorised for this household");
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}
