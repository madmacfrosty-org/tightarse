import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  rememberPendingConnection,
  takePendingConnection,
  hasPendingConnection,
} from "../src/pending-connection";

/**
 * Carrying a bank's authorisation code across a sign-in.
 *
 * From a real failure on 29 October 2026: a First Direct authorisation
 * completed and redirected back correctly, and our API was never called —
 * no Lambda invocation and no 4xx, which is what a sign-in screen looks like
 * from the outside. The journey through TrueLayer and the bank was discarded
 * because the session had lapsed while it was happening.
 *
 * Every code below is invented. This repository is public.
 */
const at = (pathname: string, search: string) => ({ pathname, search });

/**
 * An in-memory store, because this jsdom build supplies no usable
 * `localStorage` — `test-setup.ts` already guards against that.
 *
 * Written as a real Storage rather than a mock so the module under test is
 * exercised through the same calls a browser makes, including the ones that
 * can throw.
 */
const fakeStorage = (over: Partial<Storage> = {}): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    ...over,
  } as Storage;
};

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});

describe("keeping a code that arrives with nobody signed in", () => {
  it("keeps the code a bank redirect brought", () => {
    rememberPendingConnection(at("/connected", "?code=abc123&scope=info"));
    expect(takePendingConnection()).toBe("abc123");
  });

  it("ignores a page that is not the bank returning", () => {
    // The dashboard, a reload, anything else. Storing a code from elsewhere
    // would mean resending whatever happened to be in a query string.
    rememberPendingConnection(at("/", "?code=abc123"));
    expect(takePendingConnection()).toBeNull();
  });

  it("ignores a redirect that carries no code", () => {
    // A provider returning an error rather than an approval.
    rememberPendingConnection(at("/connected", "?error=access_denied"));
    expect(takePendingConnection()).toBeNull();
  });

  it("gives it back exactly once", () => {
    // A code is single-use. Leaving it behind means the next load resends a
    // spent one and reports a provider rejection that looks like real failure.
    rememberPendingConnection(at("/connected", "?code=abc123"));

    expect(takePendingConnection()).toBe("abc123");
    expect(takePendingConnection()).toBeNull();
  });

  it("discards one too old to be worth sending", () => {
    const ELEVEN_MINUTES = 11 * 60 * 1000;
    rememberPendingConnection(at("/connected", "?code=abc123"), 1_000);

    expect(takePendingConnection(1_000 + ELEVEN_MINUTES)).toBeNull();
  });

  it("still resumes one that is merely slow", () => {
    const FIVE_MINUTES = 5 * 60 * 1000;
    rememberPendingConnection(at("/connected", "?code=abc123"), 1_000);

    expect(takePendingConnection(1_000 + FIVE_MINUTES)).toBe("abc123");
  });
});

describe("knowing whether to go back for it", () => {
  it("says so without consuming it", () => {
    // `App` asks before redirecting; `Connected` is what takes it. If asking
    // consumed it, the redirect would arrive at a page with nothing to do.
    rememberPendingConnection(at("/connected", "?code=abc123"));

    expect(hasPendingConnection()).toBe(true);
    expect(takePendingConnection()).toBe("abc123");
  });

  it("says no when there is nothing, and when it is stale", () => {
    expect(hasPendingConnection()).toBe(false);
    rememberPendingConnection(at("/connected", "?code=abc123"), 1_000);
    expect(hasPendingConnection(1_000 + 11 * 60 * 1000)).toBe(false);
  });
});

describe("a store that will not cooperate", () => {
  it("does not throw when reading rubbish", () => {
    // Anything may write to localStorage, and a half-written value must not
    // take the dashboard down on load.
    localStorage.setItem("tightarse.pending_connection", "not json");

    expect(() => takePendingConnection()).not.toThrow();
    expect(hasPendingConnection()).toBe(false);
  });

  it("survives a store that throws on every call", () => {
    // Private browsing, blocked site data, a full quota. Losing the journey is
    // what happened before this existed; taking the dashboard down with it
    // would be worse.
    vi.stubGlobal("localStorage", fakeStorage({
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    }));

    expect(() => rememberPendingConnection(at("/connected", "?code=abc123"))).not.toThrow();
    expect(takePendingConnection()).toBeNull();
    expect(hasPendingConnection()).toBe(false);
  });

  it("does not throw on a value of the wrong shape", () => {
    localStorage.setItem("tightarse.pending_connection", JSON.stringify({ at: 1 }));

    expect(takePendingConnection()).toBeNull();
  });
});
