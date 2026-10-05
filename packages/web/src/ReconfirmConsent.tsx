import type { ConsentView } from "@tightarse/api-contract";

/**
 * The consent screen shown before a connection is renewed.
 *
 * Not a confirmation dialog, and the distinction matters. Remove deliberately
 * has none — "a dialog asking 'are you sure' about something already dead
 * teaches people to click through dialogs". This is the opposite case: UK
 * rules require consent to be reconfirmed with the AISP every 90 days, and
 * this screen is the reconfirmation. Nothing else asks.
 *
 * It exists because the renewal was built without it. `/connections/extend`
 * takes `user_has_reconfirmed_consent`, and we were sending `true` having
 * shown nobody anything — asserting a reconfirmation that had not happened.
 * TrueLayer refuses that until the screen has been reviewed, which is how it
 * was found: every renewal in prod returned 400 saying so.
 *
 * ## What it has to contain
 *
 * Four requirements, from TrueLayer's guidance, each of which a reviewer
 * checks. They are listed here so that editing the copy does not quietly drop
 * one:
 *
 * 1. The household must be told **TrueLayer** is the third party accessing
 *    their data. Not us — them.
 * 2. They must understand **what data** is shared.
 * 3. They must understand **what it is used for**, including that it is shared
 *    with us.
 * 4. **Links to TrueLayer's terms and privacy policy.**
 *
 * The guidance also asks for the key point in a heading, so somebody gets it
 * without reading the body, and for copy that can be skimmed rather than
 * endured.
 */

/** TrueLayer's own documents. Both verified to resolve; a dead link fails review. */
const TRUELAYER_TERMS = "https://truelayer.com/legal/enduser_tos/";
const TRUELAYER_PRIVACY = "https://truelayer.com/legal/privacy/";

/**
 * What the provider is asked for, in the household's words.
 *
 * Derived from `SCOPES` in the connect flow rather than invented, because a
 * consent screen that describes less than is requested is the one way this
 * can be actively misleading. `offline_access` is deliberately described as
 * what it does — continued access without signing in each time — rather than
 * named, because its name means nothing to a reader.
 */
const DATA_SHARED = [
  "Your account and card details — names, numbers and sort codes",
  "Your balances",
  "Your transactions, including dates, amounts and descriptions",
  "Your direct debits and standing orders",
  "Continued access, so this keeps working without you signing in each day",
] as const;

export function ReconfirmConsent({
  consent,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly consent: ConsentView;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const bank = consent.institutionName ?? "your bank";
  return (
    <div className="card" role="dialog" aria-modal="true" aria-labelledby="reconfirm-heading">
      {/* The heading carries the point: who, and that it continues. */}
      <h2 id="reconfirm-heading">
        Let TrueLayer keep sharing your {bank} data with Tightarse?
      </h2>

      <p>
        <strong>TrueLayer</strong> is the company that connects to {bank} on your behalf.
        They are authorised by the Financial Conduct Authority to access account
        information, and they are the ones who see your bank. Tightarse never sees your
        banking login.
      </p>

      <p className="note">
        Banks require this to be confirmed every 90 days. Confirming extends it; it does
        not give any new access.
      </p>

      <h3>What TrueLayer shares</h3>
      <ul>
        {DATA_SHARED.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>

      <h3>What it is used for</h3>
      <p>
        TrueLayer shares it with <strong>Tightarse</strong>, which is this application,
        so it can show your balances, your spending and where your money went. It is used
        for nothing else — it is not sold, and it is not shared with anyone further.
      </p>

      <p className="note">
        You can stop this at any time, either here or with {bank} directly. Read{" "}
        <a href={TRUELAYER_TERMS} target="_blank" rel="noreferrer noopener">
          TrueLayer&rsquo;s terms of service
        </a>{" "}
        and their{" "}
        <a href={TRUELAYER_PRIVACY} target="_blank" rel="noreferrer noopener">
          privacy policy
        </a>
        .
      </p>

      <div className="provider-row">
        <button type="button" className="provider" disabled={busy} onClick={onConfirm}>
          {busy ? "Confirming…" : "Yes, keep sharing"}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
