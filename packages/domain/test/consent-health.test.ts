/**
 * What to make of a consent row.
 *
 * The verdict comes from dates. The provider's status is carried for a reader
 * and decides nothing: their API reference types it as a bare string,
 * enumerates no values, and the ledger holds one observation of one state.
 *
 * Every date here is invented.
 */

import { describe, it, expect } from "vitest";
import { consentHealth } from "../src/household/consent.js";

const at = (s: string) => new Date(s);
const row = (expiresAt: string, fetchedAt: string) => ({ expiresAt, fetchedAt });
const opts = (now: string) => ({
  now: at(now),
  warnDays: 30,
  escalateDays: 10,
});

describe("how a consent is doing", () => {
  it("is content a long way out", () => {
    const r = consentHealth(
      row("2026-11-09T00:00:00Z", "2026-09-13T06:00:00Z"),
      opts("2026-09-13T09:00:00Z"),
    );
    expect(r.health).toBe("ok");
    expect(r.daysRemaining).toBe(56);
  });

  it("warns with a month to go, because renewal needs a person and three banks", () => {
    expect(
      consentHealth(
        row("2026-11-09T00:00:00Z", "2026-10-15T06:00:00Z"),
        opts("2026-10-15T09:00:00Z"),
      ).health,
    ).toBe("warn");
  });

  it("stops being polite inside ten days", () => {
    expect(
      consentHealth(
        row("2026-11-09T00:00:00Z", "2026-11-04T06:00:00Z"),
        opts("2026-11-04T09:00:00Z"),
      ).health,
    ).toBe("escalate");
  });

  it("says expired once the date has passed", () => {
    const r = consentHealth(
      row("2026-11-09T00:00:00Z", "2026-11-10T06:00:00Z"),
      opts("2026-11-10T09:00:00Z"),
    );
    expect(r.health).toBe("expired");
    expect(r.daysRemaining).toBeLessThan(0);
  });

  it("calls a row nobody has refreshed stale, however good its dates look", () => {
    // The case that is easy to miss. A lapsed consent cannot be refreshed, so
    // it stops producing rows — this one still claims two months left, and the
    // feed died a fortnight ago.
    const r = consentHealth(
      row("2026-11-09T00:00:00Z", "2026-08-30T06:00:00Z"),
      opts("2026-09-13T09:00:00Z"),
    );
    expect(r.health).toBe("stale");
    expect(r.daysRemaining).toBe(56);
  });

  it("puts staleness ahead of the date, not after it", () => {
    // A stale row whose date has also passed is still stale: "nobody has heard
    // from this connection" is the more useful thing to say, and the one that
    // survives the date being wrong.
    expect(
      consentHealth(
        row("2026-08-01T00:00:00Z", "2026-07-20T06:00:00Z"),
        opts("2026-09-13T09:00:00Z"),
      ).health,
    ).toBe("stale");
  });

  it("tolerates one missed sync, because the sync runs daily", () => {
    expect(
      consentHealth(
        row("2026-11-09T00:00:00Z", "2026-09-12T06:00:00Z"),
        opts("2026-09-13T09:00:00Z"),
      ).health,
    ).toBe("ok");
  });

  it("takes the thresholds it is given rather than deciding them", () => {
    const r = row("2026-11-09T00:00:00Z", "2026-09-13T06:00:00Z");
    const now = at("2026-09-13T09:00:00Z");
    expect(
      consentHealth(r, { now, warnDays: 60, escalateDays: 10 }).health,
    ).toBe("warn");
    expect(
      consentHealth(r, { now, warnDays: 90, escalateDays: 60 }).health,
    ).toBe("escalate");
  });
});
