import { describe, it, expect } from "vitest";
import { TrueLayerClient, TrueLayerError, RESOURCES } from "../src/index.js";
import { mapTransaction, mapAccount, type RawTransaction } from "../src/map.js";
import { resolveSandboxTarget, sandboxConfigured } from "../src/sandbox-target.js";

/**
 * Integration tests against TrueLayer's sandbox.
 *
 * Stage 4 of the funnel, for the provider rather than for AWS: a real external
 * service, credentialed, isolated, earning the cost by catching what a fixture
 * cannot. `map.ts` and `transform.ts` are otherwise tested against
 * `generateRawWorld` — fixtures written to match what we believe the provider
 * sends, which cannot tell us the belief is still true.
 *
 *   TL_SANDBOX_CLIENT_ID=… TL_SANDBOX_CLIENT_SECRET=… npm test -w @tightarse/truelayer
 *
 * Skipped entirely when unset, so CI without a credential stays green. Where it
 * may point is `resolveSandboxTarget`, which cannot return live — see the
 * reasoning there, and note that the danger is prod's refresh token rather
 * than anything in this repository.
 *
 * Two tiers. Most of this needs only the application credential. The refresh
 * path additionally needs a consent, which costs one interactive authorisation
 * at the mock bank (`uk-cs-mock`) and is worth doing once:
 *
 *   TL_SANDBOX_REFRESH_TOKEN=… npm test -w @tightarse/truelayer
 */

const suite = sandboxConfigured(process.env) ? describe : describe.skip;

/**
 * Resolved lazily, inside a test body.
 *
 * At module scope this would throw while collecting on an unconfigured machine,
 * turning "nothing to run here" into a failing suite — and a half-configured
 * one must still fail loudly rather than skip, which is why the two questions
 * are asked by different functions.
 */
const target = () => resolveSandboxTarget(process.env);
const client = () => {
  const t = target();
  return new TrueLayerClient(t.credentials, t.environment);
};

/** Network, against somebody else's service. Generous, but not unbounded. */
const NETWORK = 30_000;

/**
 * Retries, because the flakiness is the provider's rather than ours.
 *
 * See `credentialAcceptance`: the sandbox rejects a freshly rotated secret on
 * a majority of calls for some minutes. Retrying is right here and would be
 * wrong in a unit test — there is nothing deterministic to be had from
 * somebody else's eventually-consistent auth tier.
 */
const RETRY = { retry: 3 } as const;

/**
 * Does the application credential itself work?
 *
 * Asked with `client_credentials`, which involves no consent and no refresh
 * token — so a failure can only be the credential. That separation is the
 * whole point, and it was learned the hard way: the sandbox answers
 * `invalid_client` for a *rejected refresh token* as well as for a bad client
 * id, so that code alone cannot tell you which of the two you have.
 *
 * A helper that read the code and blamed the credential sent somebody to
 * re-check a client id that was provably fine.
 */
async function credentialTokenOnce(): Promise<boolean> {
  const t = target();
  const res = await fetch(`${t.environment.auth}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "info",
      client_id: t.credentials.clientId,
      client_secret: t.credentials.clientSecret,
    }),
  });
  return res.ok;
}

/**
 * How many of N identical attempts the sandbox accepts.
 *
 * Sampled rather than asked once, because the answer is not stable. Measured
 * on 30 September 2026, minutes after a client secret was rotated: ten
 * byte-identical `client_credentials` requests returned four 200s and six
 * `invalid_client`, in no pattern. The sandbox's auth tier appears to
 * propagate a new secret across nodes lazily, so a single call samples a coin
 * flip.
 *
 * This is the shape of the thing, not a bug to route around: a suite asking
 * once would fail the majority of the time with `invalid_client`, which reads
 * exactly like a wrong credential and sent somebody to check a client id that
 * was correct.
 */
async function credentialAcceptance(attempts = 6): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < attempts; i++) {
    if (await credentialTokenOnce()) accepted += 1;
  }
  return accepted;
}

suite("the provider's token endpoint", () => {
  it("accepts the application credential, which is the first thing to know", async () => {
    // Run this before reading any other failure in this file. `client_credentials`
    // needs no consent, so it answers "is the credential good" on its own.
    //
    // Asserted as "at least one of six", not "all six". A credential the
    // sandbox never accepts is wrong; one it accepts sometimes is right and
    // still propagating, and failing the second as though it were the first is
    // how an hour goes into re-checking a correct client id.
    const accepted = await credentialAcceptance();

    expect(
      accepted,
      "The sandbox rejected this credential on every attempt. That is a credential " +
        "problem: check TL_SANDBOX_CLIENT_ID and TL_SANDBOX_CLIENT_SECRET are the " +
        "sandbox application's, and are from the same app.",
    ).toBeGreaterThan(0);

    // Not an assertion. A partial acceptance is worth seeing in the output,
    // because it explains any flakiness in the tests below rather than leaving
    // it to be rediscovered.
    if (accepted < 6) {
      console.warn(
        `TrueLayer sandbox accepted this credential ${accepted}/6 times — ` +
          `still propagating. Tests below may fail intermittently; retry shortly.`,
      );
    }
  }, { timeout: NETWORK, ...RETRY });

  it("refuses a refresh token that was never valid, and says so as an error", async () => {
    // What the provider actually does, measured rather than assumed: the
    // sandbox answers `invalid_client` here, with a credential that
    // `client_credentials` accepts in the test above. So the code does NOT
    // identify a bad credential, and `isConsentExpired` — which looks for
    // `invalid_grant` — does not fire for it.
    //
    // Deliberately not asserted as consent expiry. A string that was never a
    // token is not a lapsed consent, and whether a genuinely expired one is
    // refused the same way is the open question: if it is, `isConsentExpired`
    // misses it and a sync retries instead of asking the household to
    // re-authorise. That needs a real consent to answer, and is why the tier
    // below exists.
    const error = await client()
      .refresh("not-a-refresh-token")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrueLayerError);
    expect((error as TrueLayerError).status).toBeGreaterThanOrEqual(400);
    expect((error as TrueLayerError).status).toBeLessThan(500);
  }, { timeout: NETWORK, ...RETRY });

  it("does not mistake a rejected credential for a lapsed consent", async () => {
    // The two are both "the token call failed" and mean opposite things: one is
    // a deployment misconfigured, the other a household that must act. Treating
    // a bad secret as an expired consent would send somebody to their bank to
    // re-authorise a connection that was never the problem.
    const t = target();
    const wrong = new TrueLayerClient(
      { clientId: t.credentials.clientId, clientSecret: "not-the-secret" },
      t.environment,
    );

    const error = await wrong
      .refresh("not-a-refresh-token")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrueLayerError);
    expect((error as TrueLayerError).status).toBeGreaterThanOrEqual(400);
  }, { timeout: NETWORK, ...RETRY });
});

/**
 * Everything below needs a consent, which is a one-off interactive step.
 *
 * Skipped rather than failed when absent: the tier above is the part that runs
 * from a credential alone, and losing it whenever no consent is to hand would
 * make the cheap half as hard to run as the expensive one.
 */
const withConsent = sandboxConfigured(process.env) && process.env["TL_SANDBOX_REFRESH_TOKEN"]
  ? describe
  : describe.skip;

withConsent("refreshing a sandbox consent", () => {
  it("returns a token set whose refresh token must be persisted", async () => {
    // The documented hazard, checked against the provider rather than against
    // our belief about it: "TrueLayer may return a NEW refresh token, and the
    // old one stops working. Keeping the original is how a connection silently
    // dies days later."
    //
    // Asserted as "there is one, and it is what you must store" rather than
    // "it differs from the input" — whether it rotates on every call is the
    // provider's business, and a test demanding rotation would fail the day
    // they stop, telling us nothing about our own correctness.
    //
    // Measured 30 September 2026: the sandbox does NOT rotate. The same token
    // comes back every time. So this suite cannot exercise the rotation path,
    // and the hazard the client documents — a new refresh token returned, the
    // old one dead, the caller still holding the original — stays untested
    // here however green it is. Only live does that, which is the one place
    // nobody wants to find out. Worth knowing before trusting a pass.
    const t = target();
    const tokens = await client().refresh(t.refreshToken!);

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(Date.parse(tokens.expiresAt)).toBeGreaterThan(Date.now());
  }, { timeout: NETWORK, ...RETRY });

  it("mints an access token the data API actually accepts", async () => {
    // The seam between the two halves of the client. `refresh` and `get` are
    // each self-consistent and were each tested against a double; what neither
    // could show is that the token one produces is the token the other needs.
    const t = target();
    const c = client();
    const { accessToken } = await c.refresh(t.refreshToken!);

    const found = await Promise.all(
      RESOURCES.map((resource) =>
        c
          .get(accessToken, `/data/v1/${resource}`)
          .then((r) => ({ resource, body: r.body as { results?: unknown[] } }))
          // A provider offering only one of the two is normal — Amex is
          // cards-only — so absence here is data, not failure.
          .catch((e: unknown) => {
            if (e instanceof TrueLayerError && e.isNotApplicable) return null;
            throw e;
          }),
      ),
    );

    const present = found.filter((f) => f !== null);
    expect(present.length).toBeGreaterThan(0);
    for (const { body } of present) expect(Array.isArray(body.results)).toBe(true);
  }, { timeout: NETWORK, ...RETRY });

  it("sends accounts this adapter can still map", async () => {
    // What a fixture cannot answer: whether the shape we parse is the shape
    // being sent. A field renamed upstream passes every unit test in this
    // package, because the fixtures were written from the old name.
    const t = target();
    const c = client();
    const { accessToken } = await c.refresh(t.refreshToken!);
    const { body } = await c.get(accessToken, "/data/v1/accounts");
    const [raw] = ((body as { results?: unknown[] }).results ?? []) as Parameters<
      typeof mapAccount
    >[0][];

    expect(raw).toBeDefined();
    const account = mapAccount(raw!, { tenantId: "sandbox" });
    expect(account.accountId).toBeTruthy();
    expect(account.currency).toMatch(/^[A-Z]{3}$/);
  }, { timeout: NETWORK, ...RETRY });

  it("sends transactions that carry the type the sign is taken from", async () => {
    // `transaction_type` is the field the whole sign convention rests on: the
    // card inversion that read every purchase as income for five years was
    // fixed by taking direction from here and nowhere else. If the provider
    // stops sending it, `mapTransaction` defaults to DEBIT and the ledger goes
    // quietly wrong in one direction — so its presence is worth asserting
    // against the real response rather than against a fixture of our own.
    const t = target();
    const c = client();
    const { accessToken } = await c.refresh(t.refreshToken!);
    const accounts = await c.get(accessToken, "/data/v1/accounts");
    const [first] = ((accounts.body as { results?: { account_id?: string }[] }).results ??
      []) as { account_id?: string }[];
    expect(first?.account_id).toBeTruthy();

    const { body } = await c.get(
      accessToken,
      `/data/v1/accounts/${first!.account_id}/transactions`,
    );
    const results = ((body as { results?: unknown[] }).results ?? []) as RawTransaction[];
    expect(results.length).toBeGreaterThan(0);

    for (const raw of results) {
      expect(["CREDIT", "DEBIT"]).toContain(raw.transaction_type);
    }

    const mapped = mapTransaction(results[0]!, {
      tenantId: "sandbox",
      accountId: first!.account_id!,
      status: "settled",
    });
    // The convention, end to end against a real payload: a DEBIT left the
    // household and is negative, whichever way the provider signed the amount.
    expect(Math.sign(mapped.amount)).toBe(results[0]!.transaction_type === "CREDIT" ? 1 : -1);
  }, { timeout: NETWORK, ...RETRY });

  it("answers a renewal request with which of three journeys is needed", async () => {
    // The question #69 could not answer without this: does TrueLayer offer a
    // reconfirmation that is not a fresh authorisation journey?
    //
    // Measured: it offers all three, and which one you get is a property of
    // the connection returned at runtime rather than something knowable in
    // advance. `action_needed` discriminates:
    //
    //   no_action_needed                 — renewed, tokens in the response
    //   reconfirmation_of_consent_needed — the light path the rules permit
    //   authentication_needed            — back to the bank
    //
    // So a renewal path cannot assume the light one. It has to branch on this
    // field, and the heavy branch is a browser journey a person must complete.
    // That is the finding: the regulation permits a confirmation, and whether
    // this particular connection gets one is the provider's call, not ours.
    //
    // Asserted as "one of the three, and a link whenever a journey is needed"
    // rather than pinned to a value. Which branch a mock connection minted
    // minutes ago takes says nothing about a real one near ninety days, and a
    // test pinned to today's answer would fail on a correct change.
    const t = target();
    const c = client();
    const { accessToken } = await c.refresh(t.refreshToken!);

    const res = await fetch(`${t.environment.api}/connections/extend`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        user_has_reconfirmed_consent: true,
        client_id: t.credentials.clientId,
        client_secret: t.credentials.clientSecret,
        // Invented, and required by the endpoint. No real person.
        user: { id: "sandbox-user-1", name: "Test User", email: "test@example.invalid" },
        refresh_token: t.refreshToken,
        redirect_uri: "http://localhost:3000/callback",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { action_needed?: string; user_input_link?: string };
    expect([
      "no_action_needed",
      "reconfirmation_of_consent_needed",
      "authentication_needed",
    ]).toContain(body.action_needed);

    // A journey that needs a person needs somewhere to send them. Without the
    // link there is no renewal path at all, only a status.
    if (body.action_needed !== "no_action_needed") {
      expect(body.user_input_link).toMatch(/^https:\/\//);
    }
  }, { timeout: NETWORK, ...RETRY });

  it("classifies an endpoint the provider does not offer as not applicable", async () => {
    // 404, 403 and 501 all mean "not here" and none is worth retrying.
    // Treating 404 as a failure once cost five redundant fetches of an entire
    // card before the step gave up, against an allowance of four a day.
    const t = target();
    const c = client();
    const { accessToken } = await c.refresh(t.refreshToken!);

    const error = await c
      .get(accessToken, "/data/v1/accounts/no-such-account/transactions")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrueLayerError);
    expect((error as TrueLayerError).isNotApplicable).toBe(true);
  }, { timeout: NETWORK, ...RETRY });
});
