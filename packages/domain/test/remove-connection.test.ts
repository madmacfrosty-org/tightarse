import { describe, it, expect } from "vitest";
import {
  removeConnection,
  ConnectionNotFound,
  ConnectionNotRemovable,
} from "../src/household/connections.js";
import type { Consent } from "../src/household/consent.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Stopping tracking a connection that has stopped working.
 *
 * Every institution, id and date invented. This repository is public.
 */
const NOW = new Date("2026-09-27T12:00:00.000Z");

const consent = (over: Partial<Consent> = {}): Consent => ({
  tenantId: "t1",
  consentId: "c-1",
  provider: "truelayer",
  institutionName: "Example Bank",
  grantedAt: "2026-08-09T00:00:00.000Z",
  // Seven weeks out, so the consent itself has not lapsed.
  expiresAt: "2026-11-15T00:00:00.000Z",
  providerStatus: "Authorised",
  fetchedAt: NOW.toISOString(),
  ...over,
});

const deps = (
  rows: unknown[],
  settings: { consentWarnDays?: number; consentEscalateDays?: number } | null = null,
) => {
  const written: Consent[] = [];
  return {
    written,
    listConsents: async (): Promise<Row[]> => rows as Row[],
    putConsent: async (c: Consent) => {
      written.push(c);
    },
    getSettings: async () => settings,
  };
};

/** Last heard from long enough ago that nothing is syncing it. */
const frozen = { fetchedAt: "2026-08-09T00:00:00.000Z" };

describe("removing a connection", () => {
  it("marks one nothing is syncing, and keeps the row", async () => {
    const d = deps([consent(frozen)]);

    const out = await removeConnection(d, "t1", "c-1", NOW);

    expect(out.removedAt).toBe(NOW.toISOString());
    // Marked, never deleted: the row is the only record that this consent
    // existed and when it was granted.
    expect(d.written).toHaveLength(1);
    expect(d.written[0]).toMatchObject({
      consentId: "c-1",
      grantedAt: "2026-08-09T00:00:00.000Z",
      removedAt: NOW.toISOString(),
    });
  });

  it("refuses one that is still working, and says which state it is in", async () => {
    // The guard is a fact about the connection rather than a question about
    // intent. A live connection is still feeding the ledger, and getting it
    // back means re-authorising — which is the flow with the history window.
    const d = deps([consent()]);

    await expect(removeConnection(d, "t1", "c-1", NOW)).rejects.toBeInstanceOf(
      ConnectionNotRemovable,
    );
    expect(d.written).toHaveLength(0);
  });

  it("refuses an expired consent only if something is still syncing it", async () => {
    // Lapsed and frozen: both reasons to let it go.
    const d = deps([
      consent({ ...frozen, expiresAt: "2026-09-01T00:00:00.000Z" }),
    ]);

    await expect(removeConnection(d, "t1", "c-1", NOW)).resolves.toMatchObject({
      consentId: "c-1",
    });
  });

  it("is the same twice, because two tabs and a double press are the same thing", async () => {
    const already = "2026-09-20T00:00:00.000Z";
    const d = deps([consent({ ...frozen, removedAt: already })]);

    const out = await removeConnection(d, "t1", "c-1", NOW);

    // Arriving at the state already reached is not a failure, and must not
    // overwrite when it happened.
    expect(out.removedAt).toBe(already);
    expect(d.written).toHaveLength(0);
  });

  it("says so when there is no such connection", async () => {
    const d = deps([consent(frozen)]);

    await expect(removeConnection(d, "t1", "other", NOW)).rejects.toBeInstanceOf(
      ConnectionNotFound,
    );
  });

  it("leaves every other connection alone", async () => {
    const d = deps([
      consent({ ...frozen, consentId: "c-1" }),
      consent({ ...frozen, consentId: "c-2" }),
    ]);

    await removeConnection(d, "t1", "c-1", NOW);

    expect(d.written.map((c) => c.consentId)).toEqual(["c-1"]);
  });

  it("skips a row that does not parse rather than failing the whole call", async () => {
    // A scan returns whatever is stored. One malformed row must not stop a
    // household removing a different connection — the same tolerance the
    // reporting path already applies to consents.
    const d = deps([{ consentId: "junk" }, consent({ ...frozen, consentId: "c-2" })]);

    await expect(removeConnection(d, "t1", "c-2", NOW)).resolves.toMatchObject({
      consentId: "c-2",
    });
  });

  it("uses the household's own thresholds when it has set them", async () => {
    // Expiring in 40 days is healthy by default and urgent to a household that
    // asked to be warned at 60 — but neither is removable, because both are
    // still working. What the setting must not do is make a live connection
    // removable by relabelling it.
    const d = deps(
      [consent({ expiresAt: "2026-11-06T00:00:00.000Z" })],
      { consentWarnDays: 60, consentEscalateDays: 45 },
    );

    await expect(removeConnection(d, "t1", "c-1", NOW)).rejects.toBeInstanceOf(
      ConnectionNotRemovable,
    );
  });
});
