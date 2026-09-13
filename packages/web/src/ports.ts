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

/**
 * Our own API.
 *
 * It read and nothing else until the dashboard could propose a rule. That is
 * the same identity and the same token doing something with effect, not a
 * different kind of access — which is why there is one port rather than two.
 *
 * **The schema is an argument, not a type parameter.** `get<Summary>(path)` was
 * a promise to the compiler that nothing checked at run time: if the API and
 * the dashboard disagreed about a field, no build and no test would notice and
 * a number would simply be missing or wrong on screen (#41). Passing the schema
 * means the response is parsed, and means a call cannot be written without
 * saying what it expects — a path this file has never heard of cannot slip
 * through unvalidated, which is what a path-to-schema lookup would have allowed.
 */
export interface Api {
  get<T>(schema: Parses<T>, path: string): Promise<T>;
  post<T>(schema: Parses<T>, path: string, body: unknown): Promise<T>;
}

/**
 * Anything that turns an unknown into a `T`, or throws.
 *
 * Structural rather than `ZodType`, so a test can hand over a plain object and
 * so this file does not take a dependency on zod to describe what it needs.
 */
export interface Parses<T> {
  parse(value: unknown): T;
}

export type { Identity };
