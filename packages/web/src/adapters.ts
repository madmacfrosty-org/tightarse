/**
 * The real implementations, and the only place the components' ports are bound
 * to Cognito and to fetch.
 *
 * Thin by design: every decision is in `auth.ts`, which these delegate to. What
 * this file buys is that `main.tsx` is the one place the binding happens, so a
 * test supplies its own object rather than replacing a module for everybody.
 */

import { apiGet, apiPost, completeSignIn, currentIdentity, signIn, signOut } from "./auth";
import type { Api, Session } from "./ports";

export const cognitoSession: Session = {
  signIn,
  signOut,
  current: currentIdentity,
  complete: completeSignIn,
};

/**
 * Parsed at the boundary, which is the only place the response is still
 * untrusted. `api-contract` was a compile-time type and an OpenAPI document
 * until now; this is where it starts earning its keep at run time (#41).
 */
export const httpApi: Api = {
  get: (schema, path) => apiGet(path).then((body) => schema.parse(body)),
  post: (schema, path, body) =>
    apiPost(path, body).then((response) => schema.parse(response)),
};
