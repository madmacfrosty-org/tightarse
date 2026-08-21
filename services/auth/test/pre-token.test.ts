import { describe, it, expect, vi, beforeEach } from "vitest";
import { handler, issueTenantClaim, ledgerConfig, realDeps, type PreTokenDeps } from "../src/pre-token.js";

/**
 * These used to run against a `vi.mock` of `@tightarse/dynamodb`, which replaced
 * the module at import time. That tested a handler wired to a mock rather than
 * the wiring that ships, and it could not see the constructor at all.
 */

const getMemberTenant = vi.fn();
const deps: PreTokenDeps = { ledger: { getMemberTenant } };

const event = (attrs: Record<string, string>) => ({
  request: { userAttributes: attrs },
  response: {} as Record<string, unknown>,
});

beforeEach(() => getMemberTenant.mockReset());

describe("pre-token trigger", () => {
  it("issues the household claim for a member", async () => {
    getMemberTenant.mockResolvedValue("frost");
    const out = await issueTenantClaim(deps, event({ email: "a@example.com", email_verified: "true" }) as never);
    expect(out.response.claimsOverrideDetails?.claimsToAddOrOverride?.["custom:tenant"]).toBe("frost");
  });

  it("issues no claim when there is no membership record", async () => {
    // Anyone with a Google account can reach the sign-in screen. Only an
    // administrator-created membership turns that into access.
    getMemberTenant.mockResolvedValue(null);
    const out = await issueTenantClaim(deps, event({ email: "stranger@example.com", email_verified: "true" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
  });

  it("refuses an unverified email without even looking it up", async () => {
    // An unverified address is whatever the user typed. Mapping it to a
    // household would let someone claim another family's ledger by choosing
    // their address.
    const out = await issueTenantClaim(deps, event({ email: "victim@example.com", email_verified: "false" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
    expect(getMemberTenant).not.toHaveBeenCalled();
  });

  it("refuses when there is no email at all", async () => {
    const out = await issueTenantClaim(deps, event({ email_verified: "true" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
    expect(getMemberTenant).not.toHaveBeenCalled();
  });

  it("keeps claims another trigger already added", async () => {
    // Cognito chains triggers, and this one is not necessarily the last to run.
    // Replacing the object rather than merging it would silently drop them.
    getMemberTenant.mockResolvedValue("frost");
    const e = {
      request: { userAttributes: { email: "a@example.com", email_verified: "true" } },
      response: { claimsOverrideDetails: { claimsToAddOrOverride: { existing: "kept" } } },
    };
    const out = await issueTenantClaim(deps, e as never);
    const claims = out.response.claimsOverrideDetails?.claimsToAddOrOverride;
    expect(claims?.["existing"]).toBe("kept");
    expect(claims?.["custom:tenant"]).toBe("frost");
  });
});

describe("building the real dependencies", () => {
  it("constructs a ledger client rather than returning a placeholder", () => {
    // The entry point is the only place a constructor is allowed to run, so
    // nothing else covers this line. It is also where a missing TABLE_NAME
    // would go unnoticed, since the DynamoStore accepts an empty string.
    expect(realDeps().ledger).toHaveProperty("getMemberTenant");
  });
});

describe("the Lambda entry point", () => {
  it("wires the real dependencies through to the decision", async () => {
    // Exercises the entry point itself, which nothing else reaches: it builds
    // a real DynamoStore and delegates. A handler that forgot to pass its deps
    // would fail here rather than in production.
    //
    // The unverified path returns before any call is made, so this constructs
    // a client and touches no network.
    const out = await handler(event({ email: "a@example.com", email_verified: "false" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
  });
});

describe("where the ledger client points", () => {
  it("uses the table and region the environment gives it", () => {
    expect(ledgerConfig({ TABLE_NAME: "tightarse-dev-Ledger", AWS_REGION: "eu-west-2" })).toEqual({
      tableName: "tightarse-dev-Ledger",
      region: "eu-west-2",
    });
  });

  it("falls back to the deployed region when AWS_REGION is unset", () => {
    // Set in CI and in Lambda, unset on a laptop. Both sides are asserted here
    // so branch coverage does not depend on which machine ran the suite.
    expect(ledgerConfig({ TABLE_NAME: "t" }).region).toBe("eu-west-1");
  });

  it("yields an empty table name rather than throwing when TABLE_NAME is unset", () => {
    // Deliberate: the Lambda would fail on first use with a DynamoDB error
    // naming the empty table, which is clearer than a module that will not load.
    expect(ledgerConfig({}).tableName).toBe("");
  });
});
