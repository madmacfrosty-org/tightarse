import { describe, it, expect, vi, beforeEach } from "vitest";

const getMemberTenant = vi.fn();
vi.mock("@tightarse/ledger", () => ({
  Ledger: class {
    getMemberTenant = getMemberTenant;
  },
}));

const { handler } = await import("./pre-token.js");

const event = (attrs: Record<string, string>) => ({
  request: { userAttributes: attrs },
  response: {} as Record<string, unknown>,
});

beforeEach(() => getMemberTenant.mockReset());

describe("pre-token trigger", () => {
  it("issues the household claim for a member", async () => {
    getMemberTenant.mockResolvedValue("frost");
    const e = event({ email: "a@example.com", email_verified: "true" });
    const out = await handler(e as never);
    expect(out.response.claimsOverrideDetails?.claimsToAddOrOverride?.["custom:tenant"]).toBe("frost");
  });

  it("issues no claim when there is no membership record", async () => {
    // Anyone with a Google account can reach the sign-in screen. Only an
    // administrator-created membership turns that into access.
    getMemberTenant.mockResolvedValue(null);
    const out = await handler(event({ email: "stranger@example.com", email_verified: "true" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
  });

  it("refuses an unverified email without even looking it up", async () => {
    // An unverified address is whatever the user typed. Mapping it to a
    // household would let someone claim another family's ledger by choosing
    // their address.
    const out = await handler(event({ email: "victim@example.com", email_verified: "false" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
    expect(getMemberTenant).not.toHaveBeenCalled();
  });

  it("refuses when there is no email at all", async () => {
    const out = await handler(event({ email_verified: "true" }) as never);
    expect(out.response.claimsOverrideDetails).toBeUndefined();
    expect(getMemberTenant).not.toHaveBeenCalled();
  });
});
