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

suite("the provider's token endpoint", () => {
  it("reports a dead consent as one a human must fix, not as a failure to retry", async () => {
    // The single most important error shape in the integration, and testable
    // with no consent at all — a token that was never valid is refused exactly
    // as an expired one is.
    //
    // `isConsentExpired` is what stops a sync retrying: the remedy is the
    // household re-authorising at the bank, and a retry loop against a lapsed
    // consent spends the call allowance achieving nothing. It is classified
    // from `invalid_grant`, which is a string in somebody else's response body
    // — the kind of thing a fixture asserts about itself.
    const error = await client()
      .refresh("not-a-refresh-token")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrueLayerError);
    expect((error as TrueLayerError).isConsentExpired).toBe(true);
    expect((error as TrueLayerError).isNotApplicable).toBe(false);
  }, NETWORK);

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
  }, NETWORK);
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
    const t = target();
    const tokens = await client().refresh(t.refreshToken!);

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(Date.parse(tokens.expiresAt)).toBeGreaterThan(Date.now());
  }, NETWORK);

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
  }, NETWORK);

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
  }, NETWORK);

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
  }, NETWORK);

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
  }, NETWORK);
});
