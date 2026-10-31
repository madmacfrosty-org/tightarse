import { describe, it, expect, vi } from "vitest";
import {
  suspendConnection,
  resumeConnection,
  ConnectionNotFound,
} from "../src/household/connections.js";
import type { Consent } from "../src/household/consent.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Stopping and restarting the sync on one connection.
 *
 * This replaces a "remove" that wrote the consent row and nothing else. The
 * sync lists connection secrets, which knew nothing about it, so a removed
 * connection vanished from the dashboard and went on syncing every morning —
 * spending the provider allowance and reporting the same problem for ever.
 *
 * Every institution, id and date invented. This repository is public.
 */
const NOW = new Date("2026-10-30T12:00:00.000Z");

const consent = (over: Partial<Consent> = {}): Consent => ({
  tenantId: "t1",
  consentId: "cred-1",
  provider: "truelayer",
  institutionName: "Example Bank",
  expiresAt: "2027-01-27T00:00:00.000Z",
  providerStatus: "Authorised",
  fetchedAt: NOW.toISOString(),
  ...over,
});

const deps = (rows: unknown[]) => {
  const written: Consent[] = [];
  const marked: Array<{ credentialsId: string; suspended: boolean }> = [];
  return {
    written,
    marked,
    listConsents: async (): Promise<Row[]> => rows as Row[],
    putConsent: async (c: Consent) => void written.push(c),
    setConnectionSuspended: async (_t: string, credentialsId: string, suspended: boolean) =>
      void marked.push({ credentialsId, suspended }),
  };
};

describe("suspending a connection", () => {
  it("marks the connection the sync reads, not only the row the page shows", async () => {
    // The whole point. Writing the row alone is what let a "removed"
    // connection keep syncing.
    const d = deps([consent()]);

    const out = await suspendConnection(d, "t1", "cred-1", NOW);

    expect(out.suspendedAt).toBe(NOW.toISOString());
    expect(d.marked).toEqual([{ credentialsId: "cred-1", suspended: true }]);
    expect(d.written[0]).toMatchObject({ suspendedAt: NOW.toISOString() });
  });

  it("stops the sync before it tells the page it has", async () => {
    // If the second write fails, the household has a connection that has
    // stopped syncing and a row that still says otherwise — visible, and
    // recoverable. The other order leaves a row claiming it is suspended
    // while the sync carries on, which is the state nobody can see.
    const order: string[] = [];
    const d = {
      listConsents: async (): Promise<Row[]> => [consent()] as Row[],
      putConsent: vi.fn(async () => void order.push("row")),
      setConnectionSuspended: vi.fn(async () => void order.push("connection")),
    };

    await suspendConnection(d, "t1", "cred-1", NOW);

    expect(order).toEqual(["connection", "row"]);
  });

  it("works on a healthy connection, which is the case that matters", async () => {
    // Reconnecting a bank leaves the old connection live and duplicating the
    // new one. Nobody should wait ninety days for it to lapse before they can
    // stop it syncing — which the old guard required.
    const d = deps([consent({ providerStatus: "Authorised" })]);

    await expect(suspendConnection(d, "t1", "cred-1", NOW)).resolves.toMatchObject({
      consentId: "cred-1",
    });
  });

  it("is the same twice, because two tabs and a double press are the same thing", async () => {
    const already = "2026-10-20T00:00:00.000Z";
    const d = deps([consent({ suspendedAt: already })]);

    const out = await suspendConnection(d, "t1", "cred-1", NOW);

    expect(out.suspendedAt).toBe(already);
    expect(d.written).toHaveLength(0);
    expect(d.marked).toHaveLength(0);
  });

  it("says so when there is no such connection", async () => {
    const d = deps([consent()]);
    await expect(suspendConnection(d, "t1", "other", NOW)).rejects.toBeInstanceOf(
      ConnectionNotFound,
    );
  });

  it("skips a row that does not parse rather than failing the whole call", async () => {
    // A scan returns whatever is stored. One malformed row must not stop a
    // household acting on a different connection.
    const d = deps([{ consentId: "junk" }, consent({ consentId: "cred-2" })]);

    await expect(suspendConnection(d, "t1", "cred-2", NOW)).resolves.toMatchObject({
      consentId: "cred-2",
    });
  });
});

describe("resuming one", () => {
  it("is the exact inverse, which is what makes suspending safe", async () => {
    const d = deps([consent({ suspendedAt: "2026-10-20T00:00:00.000Z" })]);

    await resumeConnection(d, "t1", "cred-1");

    expect(d.marked).toEqual([{ credentialsId: "cred-1", suspended: false }]);
    expect(d.written[0]).toBeDefined();
    expect(d.written[0]).not.toHaveProperty("suspendedAt");
  });

  it("does nothing to one that was never suspended", async () => {
    const d = deps([consent()]);

    await resumeConnection(d, "t1", "cred-1");

    expect(d.written).toHaveLength(0);
    expect(d.marked).toHaveLength(0);
  });
});
