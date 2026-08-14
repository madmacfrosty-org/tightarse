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

/**
 * Everything this trigger reaches outside itself.
 *
 * A structural type rather than `Ledger`, so a test supplies an object with one
 * method and the compiler still checks the call. Mocking the module worked, but
 * it tested a handler wired to a mock at import time rather than the wiring
 * that ships — and it silently stopped covering anything the constructor does.
 */
export interface PreTokenDeps {
  readonly ledger: Pick<Ledger, "getMemberTenant">;
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): PreTokenDeps {
  return {
    ledger: new Ledger({
      tableName: process.env["TABLE_NAME"] ?? "",
      region: process.env["AWS_REGION"] ?? "eu-west-1",
    }),
  };
}

export async function issueTenantClaim(
  deps: PreTokenDeps,
  event: PreTokenEvent,
): Promise<PreTokenEvent> {
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

  const tenantId = await deps.ledger.getMemberTenant(email);
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

/**
 * Lambda entry point, and the only place a client is constructed.
 *
 * Memoised rather than built per invocation, so a warm container reuses the
 * connection pool — the reason the constructor sat at module scope in the first
 * place. Deferring it to the first call keeps that benefit and still leaves the
 * module importable without the environment set.
 */
let deps: PreTokenDeps | undefined;

export async function handler(event: PreTokenEvent): Promise<PreTokenEvent> {
  deps ??= realDeps();
  return issueTenantClaim(deps, event);
}
