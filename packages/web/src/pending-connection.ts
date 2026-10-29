/**
 * An authorisation code that arrived while nobody was signed in.
 *
 * The bank's redirect lands on `/connected?code=…`, and `App` renders the
 * sign-in screen instead of the route whenever there is no session. Signing in
 * goes to Cognito and comes back to the site's origin — not to `/connected` —
 * so the code is gone, and with it the whole journey: TrueLayer, the bank's
 * own login, the approval. The household sees a dashboard and no new
 * connection, and nothing anywhere says why.
 *
 * Observed in prod on 29 October 2026. The bank authorisation completed and
 * redirected back correctly; our API was never called at all — no Lambda
 * invocation and no 4xx, which is the signature of a page that renders a
 * sign-in form rather than making a request.
 *
 * It is not an unlikely path. The journey leaves the site for two other
 * domains and can take minutes; a phone may discard the tab's `sessionStorage`
 * while the banking app is in front, and that is where the tokens live
 * deliberately — "bank data on a machine that may not be one person's".
 *
 * ## Why localStorage is acceptable here, when tokens are not
 *
 * This is not a token. An authorisation code is single-use, short-lived, and —
 * as `completeConnect` puts it — "worthless without the client secret, which
 * never leaves AWS". Someone holding it can do nothing with it; someone
 * holding a token can read a household's bank account.
 *
 * It is still removed the moment it is read, and ignored once stale, so the
 * window in which it exists at all is the sign-in round trip it was stored to
 * survive.
 */

const KEY = "tightarse.pending_connection";

/**
 * How long a stored code is worth resuming.
 *
 * Generous enough for a sign-in redirect and mean enough that a code found
 * tomorrow is discarded rather than sent. The provider expires these itself;
 * this only decides whether we bother, and sending a stale one produces a
 * provider rejection that reads like a real failure.
 */
const USABLE_FOR_MS = 10 * 60 * 1000;

interface Pending {
  readonly code: string;
  readonly at: number;
}

/** Storage that cannot throw. Private browsing and blocked site data both do. */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Keep the code in the URL, if this looks like a bank returning.
 *
 * Called before the session is known, because that is the only moment it is
 * still there: the sign-in redirect is what destroys it.
 *
 * Deliberately does not clear the query string. When a session does exist the
 * normal path reads it straight from the URL, and this is then a copy that the
 * same read discards.
 */
export function rememberPendingConnection(
  location: { pathname: string; search: string } = window.location,
  now: number = Date.now(),
): void {
  if (!location.pathname.startsWith("/connected")) return;
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;

  const s = store();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify({ code, at: now } satisfies Pending));
  } catch {
    // A full or refusing store is not worth failing sign-in over. The journey
    // is lost, which is what happened before this existed.
  }
}

/**
 * Take the code back, once.
 *
 * Removed before it is returned rather than after it is used: a code that
 * fails is spent either way, and leaving it behind means the next page load
 * resends it and reports a provider rejection that looks like a real failure.
 */
export function takePendingConnection(now: number = Date.now()): string | null {
  const s = store();
  if (!s) return null;

  let raw: string | null = null;
  try {
    raw = s.getItem(KEY);
    s.removeItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const pending = JSON.parse(raw) as Partial<Pending>;
    if (typeof pending.code !== "string" || typeof pending.at !== "number") return null;
    if (now - pending.at > USABLE_FOR_MS) return null;
    return pending.code;
  } catch {
    return null;
  }
}

/**
 * Whether there is a journey worth returning to, without consuming it.
 *
 * `App` asks this after signing in, to decide whether to go back to
 * `/connected` rather than leave somebody on the dashboard wondering where
 * their bank went.
 */
export function hasPendingConnection(now: number = Date.now()): boolean {
  const s = store();
  if (!s) return false;
  try {
    const raw = s.getItem(KEY);
    if (raw === null) return false;
    const pending = JSON.parse(raw) as Partial<Pending>;
    return typeof pending.code === "string" && typeof pending.at === "number"
      ? now - pending.at <= USABLE_FOR_MS
      : false;
  } catch {
    return false;
  }
}
