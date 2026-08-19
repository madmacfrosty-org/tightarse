/**
 * The real implementations, and the only place the components' ports are bound
 * to Cognito and to fetch.
 *
 * Thin by design: every decision is in `auth.ts`, which these delegate to. What
 * this file buys is that `main.tsx` is the one place the binding happens, so a
 * test supplies its own object rather than replacing a module for everybody.
 */

import { apiGet, completeSignIn, currentIdentity, signIn, signOut } from "./auth";
import type { Api, Session } from "./ports";

export const cognitoSession: Session = {
  signIn,
  signOut,
  current: currentIdentity,
  complete: completeSignIn,
};

export const httpApi: Api = { get: apiGet };
