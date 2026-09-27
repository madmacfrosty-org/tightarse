import { useEffect, useState } from "react";
import { BrowserRouter, Link, NavLink, Outlet, Route, Routes } from "react-router-dom";
import type { Api, Identity, Session } from "./ports";
import { Connected } from "./Connect";
import { Home } from "./Home";
import { Spending } from "./Spending";
import { Categories } from "./Categories";
import { Operations } from "./Operations";

function SignIn({ error, onSignIn }: { error: string | null; onSignIn: () => void }) {
  return (
    <div className="page" style={{ maxWidth: 380 }}>
      <h1>Tightarse</h1>
      <div className="card">
        <h2>Sign in</h2>
        <p className="note">
          Your household ledger. Sign in with Google, or with an email and password.
        </p>
        <button type="submit" onClick={onSignIn}>Continue to sign in</button>
        {error ? <p className="error" style={{ padding: "12px 0 0", fontSize: 13 }}>{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * The pages, named by where they go.
 *
 * Three of them, because three is what a household uses weekly: where we stand,
 * where it went, and keeping the categories honest. `/operations` is deliberately
 * not among them — see below.
 */
const PAGES = [
  { to: "/", label: "Home" },
  { to: "/spending", label: "Spending" },
  { to: "/categories", label: "Categories" },
] as const;

/**
 * Navigation on every page, naming the destination and marking the current one.
 *
 * `NavLink` sets `aria-current="page"` on the active one, so "which am I on" is
 * answered for a screen reader as well as for the eye — the styling below hangs
 * off the same attribute rather than a second source of truth.
 *
 * `end` on `/` because every other path starts with it, and without it the home
 * link is marked current on all four pages.
 */
function Nav() {
  return (
    <nav className="nav" aria-label="Pages">
      {PAGES.map((p) => (
        <NavLink key={p.to} to={p.to} end={p.to === "/"}>
          {p.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The frame every page shares: who is signed in, and how to get elsewhere.
 *
 * The range selector used to live here, which is how a glance came to have a
 * control on it. It belongs to `/spending` now, because a period is a question
 * about reviewing and a position is a statement about now.
 */
function Chrome({ identity, session }: { identity: Identity; session: Session }) {
  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Tightarse</h1>
          <div className="subtle">
            {identity.email}
            {" · "}
            <button
              onClick={() => void session.signOut()}
              style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--in)", cursor: "pointer" }}
            >
              sign out
            </button>
            {" · "}
            {/*
              Reachable without typing an address, and not given the prominence
              of the three above. Urgent operator work comes to you — a consent
              near expiry is announced on `/` — and routine operator work is
              something you go to, rarely, from here.
            */}
            <NavLink to="/operations" className="quiet">Operations</NavLink>
          </div>
        </div>
        <Nav />
      </header>
      <Outlet />
    </div>
  );
}

/**
 * An address that is not a page.
 *
 * Says so, rather than rendering the glance as though the address had been
 * right: a figure under the wrong heading is worse than no figure. CloudFront
 * serves `index.html` for 403 and 404 alike, so a mistyped path arrives here
 * rather than at the bucket's error page.
 */
function NotFound() {
  return (
    <div className="card">
      <h2>That page does not exist</h2>
      <p className="note">
        Nothing is served at this address. Nothing has been lost — the address is
        simply not one of the pages.
      </p>
      <Link to="/">Back to where we stand</Link>
    </div>
  );
}

/**
 * The application.
 *
 * Takes its session and API rather than importing them, so a test supplies an
 * object instead of replacing a module — and so the wiring that ships is the
 * wiring a test exercises.
 *
 * Signing in gates everything, which is why it is here and not in a route: a
 * page under it never renders for an unknown visitor, so no page has to check.
 */
export function App({ session, api }: { session: Session; api: Api }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Safe on every load: returns null when this is not a redirect back.
    session.complete()
      .then((fromRedirect) => fromRedirect ?? session.current())
      .then(setIdentity)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Sign in failed"))
      .finally(() => setChecking(false));
    // `session` is the injected port, bound once as a module-level constant in
    // main.tsx, so its identity never changes and this still runs exactly once on
    // mount. Listed anyway: if a caller ever passed a different adapter, running
    // against the new one is correct, and an empty array would silently keep the old.
  }, [session]);

  if (checking) return <div className="page loading">Checking session…</div>;
  if (error && !identity) return <div className="page error">{error}</div>;
  if (!identity) return <SignIn error={error} onSignIn={() => void session.signIn()} />;

  return (
    <BrowserRouter>
      <Routes>
        {/*
          The one route where a mistake is unrecoverable.

          The provider redirects here after a bank authorisation, and roughly an
          hour later only ninety days of history remain available, for ever. It
          is declared first, and outside the chrome, so it cannot be shadowed by
          a layout route or swallowed by the catch-all: the callback is a
          handover, not a page of the application.
        */}
        <Route path="/connected" element={<Connected api={api} onFinished={() => window.location.assign("/")} />} />
        <Route element={<Chrome identity={identity} session={session} />}>
          <Route index element={<Home api={api} />} />
          <Route path="/spending" element={<Spending api={api} />} />
          <Route path="/categories" element={<Categories api={api} />} />
          <Route path="/operations" element={<Operations api={api} />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
