/**
 * What the dashboard needs of the outside, declared by the dashboard.
 *
 * The components used to import `apiGet` and `currentIdentity` directly from
 * `auth.ts`, so every test replaced that whole module with `vi.mock`. The backend
 * abandoned that approach and wrote down why: it "tested a handler wired to a
 * mock at import time rather than the wiring that ships — and it silently stopped
 * covering anything the constructor does."
 *
 * The same argument applies here, and this week supplied the evidence. Neither
 * the CORS failure nor the blank page from a CommonJS import was reachable by any
 * test that replaces `auth` wholesale, because both lived in the wiring those
 * tests substitute away.
 *
 * Two ports rather than one, because they are two different outside things: a
 * Cognito hosted UI, and our own API.
 */

import type { Identity } from "./auth";

/** Signing in, and knowing who is signed in. Talks to Cognito's hosted UI. */
export interface Session {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Whoever is signed in, or null. Does not redirect. */
  current(): Promise<Identity | null>;
  /**
   * Finish a redirect back from the provider, or null if this is not one.
   *
   * Safe to call on every load, which is why it is separate from `current`: the
   * dashboard cannot know whether it is being loaded fresh or returned to.
   */
  complete(): Promise<Identity | null>;
}

/** Reading from the API. No write methods, because the dashboard makes none. */
export interface Api {
  get<T>(path: string): Promise<T>;
}

export type { Identity };
