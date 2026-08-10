import { Ledger } from "@tightarse/ledger";

/**
 * Cognito pre-token-generation trigger.
 *
 * Federated sign-in has no password and no attribute we control: Google's token
 * says who someone is, not which household they may read. Cognito creates the
 * pool user automatically on first sign-in, so `custom:tenant` is never set.
 *
 * This injects it, from an explicit membership record that only an
 * administrator can create. Anyone with a Google account can reach the sign-in
 * screen; only someone with a membership record leaves it with a usable token.
 *
 * Fails closed. No membership, no claim — and the API rejects a token without
 * one, so an unknown identity gets a 403 rather than somebody's ledger.
 */

interface PreTokenEvent {
  request: {
    userAttributes: Record<string, string>;
  };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
    };
  };
}

const ledger = new Ledger({
  tableName: process.env["TABLE_NAME"] ?? "",
  region: process.env["AWS_REGION"] ?? "eu-west-1",
});

export async function handler(event: PreTokenEvent): Promise<PreTokenEvent> {
  const attrs = event.request.userAttributes;

  // Only a verified email may be trusted to identify a person. An unverified
  // one can be anything the user typed, and mapping it to a household would let
  // someone claim another family's ledger by choosing their address.
  const verified = attrs["email_verified"] === "true";
  const email = attrs["email"];

  if (!verified || !email) {
    console.log(JSON.stringify({ decision: "no-claim", reason: verified ? "no-email" : "email-unverified" }));
    return event;
  }

  const tenantId = await ledger.getMemberTenant(email);
  if (!tenantId) {
    // Logged so an intended family member who cannot get in is diagnosable,
    // without recording anything about what they were trying to reach.
    console.log(JSON.stringify({ decision: "no-claim", reason: "no-membership" }));
    return event;
  }

  event.response.claimsOverrideDetails = {
    ...event.response.claimsOverrideDetails,
    claimsToAddOrOverride: {
      ...event.response.claimsOverrideDetails?.claimsToAddOrOverride,
      "custom:tenant": tenantId,
    },
  };
  console.log(JSON.stringify({ decision: "claim-issued", tenantId }));
  return event;
}
