import { describe, it, expect } from "vitest";
import { selectConnections } from "./steps.js";
import type { Connection } from "./connections.js";

const conn = (connectionId: string): Connection => ({
  connectionId,
  tenantId: "frost",
  provider: "truelayer",
  refreshToken: `r-${connectionId}`,
  consentExpiresAt: "2026-12-01T00:00:00.000Z",
  connectedAt: "2026-08-01T00:00:00.000Z",
});

const all = [conn("first-direct"), conn("his-amex"), conn("her-amex")];

describe("selectConnections", () => {
  it("returns every connection when there is no input", () => {
    // The daily run, and any execution started with no input at all — Step
    // Functions defaults that to {}.
    expect(selectConnections(all, {})).toHaveLength(3);
    expect(selectConnections(all, undefined)).toHaveLength(3);
  });

  it("returns only the connection a connect just made", () => {
    // Adding a second Amex must not spend the others' unattended-call budget
    // (four per 24 hours, per consent), nor let an unrelated failure muddy the
    // execution whose deep-history window is the one closing.
    expect(selectConnections(all, { connectionId: "her-amex" }).map((c) => c.connectionId)).toEqual([
      "her-amex",
    ]);
  });

  it("refuses a connectionId that matches nothing", () => {
    expect(() => selectConnections(all, { connectionId: "ghost" })).toThrow(/No connection ghost/);
  });
});
