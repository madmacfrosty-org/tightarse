import { useEffect, useState } from "react";
import { apiGet } from "./auth";

/**
 * Connecting a bank.
 *
 * A redirect chain, not a form: we ask the API for the provider's consent URL,
 * the browser goes there, the household authorises at their bank, and the
 * provider returns to /connected with a code that the API exchanges.
 *
 * Nothing sensitive passes through here. The code is single-use and worthless
 * without the client secret, which never leaves AWS.
 */

const PROVIDERS = [
  { id: "ob-first-direct", label: "First Direct" },
  { id: "ob-amex", label: "American Express" },
  { id: "uk-ob-all uk-oauth-all", label: "Another bank…" },
] as const;

export function ConnectBank() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = (provider: string) => {
    setBusy(provider);
    setError(null);
    apiGet<{ url: string }>(`/connect/start?provider=${encodeURIComponent(provider)}`)
      .then(({ url }) => window.location.assign(url))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not start");
        setBusy(null);
      });
  };

  return (
    <div className="card">
      <h2>Connect a bank</h2>
      <p className="note">
        You will be sent to your bank to authorise access. Tightarse never sees your
        banking credentials. Access lasts 90 days, after which you reconfirm.
      </p>
      <div className="provider-row">
        {PROVIDERS.map((p) => (
          <button key={p.id} className="provider" disabled={busy !== null} onClick={() => start(p.id)}>
            {busy === p.id ? "Redirecting…" : p.label}
          </button>
        ))}
      </div>
      {error ? <p className="error" style={{ padding: "12px 0 0", fontSize: 13 }}>{error}</p> : null}
    </div>
  );
}

type State = { phase: "working" } | { phase: "done"; expires: string } | { phase: "failed"; message: string };

/**
 * The page the provider redirects back to.
 *
 * Exchanging the code also starts the first sync, which runs for minutes behind
 * a state machine — so this reports that the connection was made, not that the
 * data has arrived.
 */
export function Connected({ onFinished }: { onFinished: () => void }) {
  const [state, setState] = useState<State>({ phase: "working" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      setState({ phase: "failed", message: error });
      return;
    }
    if (!code) {
      setState({ phase: "failed", message: "No authorisation code in the redirect." });
      return;
    }

    apiGet<{ connectionId: string; consentExpiresAt: string }>(
      `/connect/callback?code=${encodeURIComponent(code)}`,
    )
      .then((r) => setState({ phase: "done", expires: r.consentExpiresAt.slice(0, 10) }))
      .catch((e: unknown) =>
        setState({ phase: "failed", message: e instanceof Error ? e.message : "Exchange failed" }),
      );
  }, []);

  return (
    <div className="page" style={{ maxWidth: 460 }}>
      <h1>Tightarse</h1>
      <div className="card">
        {state.phase === "working" ? (
          <>
            <h2>Finishing up</h2>
            <p className="note">Exchanging the authorisation with your bank.</p>
          </>
        ) : null}

        {state.phase === "done" ? (
          <>
            <h2>Connected</h2>
            <p className="note">
              Your first sync has started and will take a few minutes — it fetches up to five
              years of history, which is only available in the window that just opened.
            </p>
            <p className="note">
              Access expires <strong>{state.expires}</strong>. You will be reminded ten days before.
            </p>
            <button type="submit" onClick={onFinished}>Back to the dashboard</button>
          </>
        ) : null}

        {state.phase === "failed" ? (
          <>
            <h2>That did not work</h2>
            <p className="note">{state.message}</p>
            <button type="submit" onClick={onFinished}>Back to the dashboard</button>
          </>
        ) : null}
      </div>
    </div>
  );
}
