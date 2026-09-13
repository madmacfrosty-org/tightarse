import type { ConsentView } from "@tightarse/api-contract";

/**
 * The one thing on this dashboard with a deadline.
 *
 * A bank authorisation lasts ninety days and nothing renews it. When it lapses
 * the feed stops, and every figure on the page goes on looking exactly as
 * healthy as it did the day before — so this is deliberately the first thing on
 * the screen rather than a footnote next to the account it concerns.
 *
 * `stale` is the case worth understanding. A lapsed consent cannot be
 * refreshed, so it stops producing rows: the row freezes rather than turning
 * bad. A comfortable number on a row nobody has refreshed is not good news, and
 * is reported as loudly as an expiry.
 */

function describe(c: ConsentView): string {
  const who = c.institutionName ?? "A bank connection";
  if (c.health === "stale") {
    return `${who} has not reported in. Its consent may already have lapsed — the feed stops without saying so.`;
  }
  if (c.health === "expired") {
    return `${who} has expired. The feed has stopped and reconnecting is the only way back.`;
  }
  const days = c.daysRemaining;
  return `${who} expires in ${days} day${days === 1 ? "" : "s"}. Reconfirm before then or the feed stops.`;
}

export function ConsentNotice({ consents }: { consents: readonly ConsentView[] }) {
  // Nothing to say is not the same as all well: the list is empty until a sync
  // has written one, so silence here means "not known yet", and a screen that
  // announced good news would be inventing it.
  const trouble = consents.filter((c) => c.health !== "ok");
  if (trouble.length === 0) return null;

  const worst = trouble.some((c) => c.health === "expired" || c.health === "stale")
    ? "expired"
    : trouble.some((c) => c.health === "escalate")
      ? "escalate"
      : "warn";

  return (
    <div className={`card consent-notice ${worst}`} role="status">
      <h2>Bank connections</h2>
      <ul>
        {trouble.map((c) => (
          <li key={c.consentId}>
            {describe(c)}{" "}
            <span className="subtle">
              provider says &ldquo;{c.providerStatus}&rdquo;
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
