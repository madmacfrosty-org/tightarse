import { randomUUID } from "node:crypto";
import { TrueLayerClient, LIVE, SANDBOX, TrueLayerError } from "@tightarse/truelayer";
import { Connections, consentExpiry, type Connection } from "./connections.js";
import { AwsSecrets, startExecution } from "@tightarse/aws";
import { ReconfirmConnectionRequest } from "@tightarse/api-contract";

/**
 * The connect flow: turn a bank authorisation into a stored connection.
 *
 * Two routes. `/connect/start` builds the provider's consent URL; the browser
 * follows it, the household authorises at their bank, and the provider returns
 * to `/connect/callback` with a code. That code is exchanged once, and the
 * refresh token is stored.
 *
 * The refresh token is the entire point. The probe that gathered the original
 * five years discarded it, which is why nothing has been able to sync since —
 * a consent without a stored token is a snapshot, not a connection.
 */

export interface ConnectDeps {
  readonly truelayer: TrueLayerClient;
  readonly connections: Connections;
  readonly redirectUri: string;
  readonly providers: string;
  /** TrueLayer application client id, for the consent URL. */
  readonly clientId: string;
  /** Provider authorisation host — sandbox or live. */
  readonly authBase: string;
  /**
   * Start the first sync for a brand-new connection, without waiting for it.
   *
   * A function rather than a client and an ARN, because what matters at this
   * seam is whether it is called at all: the deep-history window shuts within
   * the hour, and a connection that misses it is silently reduced to 90 days.
   * Undefined where no state machine is configured.
   */
  readonly startSync?: ((connectionId: string) => Promise<void>) | undefined;
  /**
   * Whether this deployment owns the household's connections.
   *
   * Renewal spends and replaces a refresh token, so only the deployment
   * holding them may do it — the same ownership `syncEnabled` states for the
   * daily refresh, and the same failure if two deployments both act: the
   * loser writes back a token the winner has already spent and the connection
   * dies days later.
   *
   * Gated here rather than only in the dashboard. A control that is not
   * rendered is not a control that cannot be called.
   */
  readonly ownsConnections: boolean;
  /** Whether this deployment talks to the sandbox. Decides which banks exist. */
  readonly sandbox: boolean;
  /**
   * An address for the household, as the extend endpoint asks for.
   *
   * Not used to reach anybody — nothing here sends mail. It is part of the
   * `user` object TrueLayer's reference requires, and we were omitting it.
   */
  readonly contactEmail: string;
}

/**
 * Scopes requested at consent time.
 *
 * `offline_access` is what yields a refresh token; without it the connection
 * dies with the first access token. `cards` matters because Amex offers nothing
 * else, and First Direct's credit card would otherwise be invisible.
 */
export const SCOPES = [
  "info",
  "accounts",
  "balance",
  "cards",
  "transactions",
  "direct_debits",
  "standing_orders",
  "offline_access",
] as const;

export function authorisationUrl(
  clientId: string,
  deps: Pick<ConnectDeps, "redirectUri" | "providers">,
  state: string,
  authBase = "https://auth.truelayer.com",
): string {
  const url = new URL("/", authBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("redirect_uri", deps.redirectUri);
  url.searchParams.set("providers", deps.providers);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Providers offerable directly, skipping TrueLayer's full picker.
 *
 * An allow-list rather than passing the parameter through: `providers` steers
 * where someone is sent to enter bank credentials, and that is not a value to
 * accept unchecked from a query string.
 */
export const LIVE_PROVIDERS = ["ob-first-direct", "ob-amex", "uk-ob-all uk-oauth-all"];

/** TrueLayer's mock bank. It exists in the sandbox and nowhere else. */
export const SANDBOX_PROVIDERS = ["uk-cs-mock"];

export const ALLOWED_PROVIDERS = [...LIVE_PROVIDERS, ...SANDBOX_PROVIDERS];

/**
 * The providers that exist in a given environment.
 *
 * Gated on the environment, which an earlier version of this deliberately did
 * not do — on the reasoning that asking for a provider that is not there
 * "fails visibly at the provider rather than silently here". It does not fail
 * visibly. Measured on 4 October 2026: dev offered First Direct against the
 * sandbox, this function's predecessor accepted it, the Lambda logged a clean
 * success, and TrueLayer answered the redirect with a bare bad request. The
 * household is then on somebody else's error page with nothing connecting it
 * to what they clicked.
 *
 * Refusing here costs one check and produces a message naming the problem.
 */
export function providersForEnvironment(sandbox: boolean): readonly string[] {
  return sandbox ? SANDBOX_PROVIDERS : LIVE_PROVIDERS;
}

export interface ConnectResult {
  connectionId: string;
  consentExpiresAt: string;
}

/**
 * Exchange the authorisation code and store the connection.
 *
 * Deliberately does NOT fetch any data itself: a fetch inside a redirect
 * handler runs under a browser timeout, and losing a five-year history half way
 * would cost the consent.
 *
 * The caller starts the sync state machine instead — immediately, without
 * waiting. Leaving it to the daily schedule would have been worse than a
 * timeout: the deep-history window shuts within the hour, so a new connection
 * would quietly have been reduced to 90 days, visible only as charts that
 * looked oddly short.
 */
export async function completeConnect(
  deps: ConnectDeps,
  args: { tenantId: string; code: string; now?: Date },
): Promise<ConnectResult> {
  const tokens = await deps.truelayer.exchangeCode(args.code, deps.redirectUri);

  const connection: Connection = {
    connectionId: randomUUID(),
    tenantId: args.tenantId,
    provider: "truelayer",
    refreshToken: tokens.refreshToken,
    consentExpiresAt: consentExpiry(args.now ?? new Date()),
    connectedAt: (args.now ?? new Date()).toISOString(),
  };

  await deps.connections.create(connection);
  return { connectionId: connection.connectionId, consentExpiresAt: connection.consentExpiresAt };
}

export interface ConnectEvent {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
}

/**
 * Build the real dependencies from the environment.
 *
 * Called by the Lambda entry point, and by nothing a test runs. Async because
 * the TrueLayer client needs the application secret.
 */
export async function realConnectDeps(): Promise<ConnectDeps> {
  const secrets = new AwsSecrets();
  const stored = await secrets.get(required("CLIENT_SECRET_ID"));
  const creds = JSON.parse(stored ?? "{}") as { clientId: string; clientSecret: string };
  const sandbox = process.env["TL_ENV"] === "sandbox";
  const machine = process.env["SYNC_STATE_MACHINE_ARN"];

  return {
    truelayer: new TrueLayerClient(creds, sandbox ? SANDBOX : LIVE),
    connections: new Connections(required("CONNECTION_SECRET_PREFIX"), secrets),
    redirectUri: required("CONNECT_REDIRECT_URI"),
    providers: process.env["TL_PROVIDERS"] ?? "uk-ob-all uk-oauth-all",
    // Default false. A deployment that has not said it owns the connections
    // does not, and the safe answer is the one you get by omission.
    ownsConnections: process.env["CONNECTIONS_OWNED"] === "true",
    sandbox,
    contactEmail: process.env["CONTACT_EMAIL"] ?? "household@example.invalid",
    clientId: creds.clientId,
    authBase: sandbox ? SANDBOX.auth : LIVE.auth,
    ...(machine
      ? {
          // Only the connection just made. Its deep-history window is the one
          // that shuts within the hour; the others are synced on schedule and
          // have their own rate limits to protect.
          startSync: (connectionId: string) =>
            startExecution(machine, `connect-${connectionId}`, { connectionId }),
        }
      : {}),
  };
}

export class ConsentNotRenewable extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
  }
}

export class ConsentUnknown extends Error {
  readonly statusCode = 404;
  constructor(consentId: string) {
    super(`No connection matches consent ${consentId}`);
  }
}

/**
 * Refresh a connection's access token, persisting whatever comes back.
 *
 * The one rule that governs every use of `refresh` in this codebase, stated
 * once so it cannot be forgotten in a third place: TrueLayer may return a NEW
 * refresh token and the old one stops working, so the caller must store what
 * it is given BEFORE doing anything that could fail.
 *
 * `steps.ts` has always done this on the sync path. The renewal path did not,
 * in two places, and the sandbox hid it by never rotating.
 *
 * Returns the connection as it now is, so callers use the live token rather
 * than the one they were holding.
 */
async function refreshAndStore(
  deps: Pick<ConnectDeps, "truelayer" | "connections">,
  connection: Connection,
): Promise<{ connection: Connection; accessToken: string }> {
  const tokens = await deps.truelayer.refresh(connection.refreshToken);
  if (tokens.refreshToken !== connection.refreshToken) {
    const rotated = { ...connection, refreshToken: tokens.refreshToken };
    await deps.connections.update(rotated);
    return { connection: rotated, accessToken: tokens.accessToken };
  }
  return { connection, accessToken: tokens.accessToken };
}

/**
 * Find the connection behind a consent id, filling in the link if absent.
 *
 * The dashboard knows a consent by the provider's `credentials_id`; the stored
 * secrets are keyed by our own connection id, and until renewal needed it
 * nothing recorded which was which. Resolving costs one `/me` call per
 * connection lacking the link, and the answer is stored, so it is paid once
 * per connection rather than once per renewal.
 *
 * Connections that already carry the link are matched without any call at all,
 * which is what keeps this off the unattended allowance in the normal case.
 */
export async function connectionForConsent(
  deps: Pick<ConnectDeps, "truelayer" | "connections">,
  tenantId: string,
  consentId: string,
): Promise<Connection> {
  const all = await deps.connections.list(tenantId);

  const known = all.find((c) => c.credentialsId === consentId);
  if (known) return known;

  for (const connection of all.filter((c) => c.credentialsId === undefined)) {
    // Refreshing may rotate. Whatever comes back is stored before anything
    // else happens, because the old token stops working the moment the new
    // one is issued — the hazard `TrueLayerClient.refresh` documents, and the
    // discipline `steps.ts` already follows on the sync path.
    //
    // This probe did not, and discarded the new token while writing the old
    // one back. Invisible in the sandbox, which does not rotate; potentially
    // fatal against a bank that does.
    const current = await refreshAndStore(deps, connection);

    const { body } = await deps.truelayer.get(current.accessToken, "/data/v1/me");
    const credentialsId = (
      (body as { results?: { credentials_id?: string }[] }).results ?? []
    )[0]?.credentials_id;
    if (credentialsId === undefined) continue;

    // Stored whatever the outcome, so a connection is probed once ever rather
    // than once per attempt at renewing a different one.
    const linked = { ...current.connection, credentialsId };
    await deps.connections.update(linked);
    if (credentialsId === consentId) return linked;
  }

  throw new ConsentUnknown(consentId);
}

/**
 * Renew a consent before it lapses.
 *
 * Refuses one that has already gone: there is nothing left to extend and the
 * remedy is connecting again, which is a different act with a different cost.
 *
 * When the provider renews without asking anything, the new refresh token is
 * stored BEFORE the answer is returned. That ordering is the whole risk in
 * this function — the old token stops working at the moment the new one is
 * issued, so a failure between the two loses the connection, and the only way
 * back is a consent that buys ninety days and no history.
 */
export async function reconfirmConnection(
  deps: ConnectDeps,
  tenantId: string,
  consentId: string,
): Promise<{ consentId: string; action: "renewed" | "consent" | "authentication"; continueAt?: string; expiresAt?: string }> {
  const connection = await connectionForConsent(deps, tenantId, consentId);

  // Deliberately no check against `connection.consentExpiresAt`.
  //
  // It was one, and it was wrong twice over. The stored date is our record of
  // what the provider said at connect time, and the provider is the authority
  // on whether a consent can still be extended — it answers that in the call
  // below, with a reason. Guarding on a local copy refuses renewals the
  // provider would have allowed, and on 4 October 2026 it refused all three
  // of prod's after a bug overwrote that field with an access-token lifetime.
  //
  // A genuinely lapsed consent comes back as a TrueLayerError, which the route
  // turns into a 502 carrying the provider's own words.

  // Same rule, and the reason renewal failed against prod's banks while
  // working against the sandbox. This refreshed, kept only the access token,
  // and then handed `extendConnection` the ORIGINAL refresh token — which the
  // refresh had just replaced. The provider cannot extend a connection
  // identified by a token it has already retired.
  //
  // The sandbox does not rotate (measured, `cec9a89`), so the original stayed
  // valid there and the whole thing appeared to work.
  const current = await refreshAndStore(deps, connection);

  const outcome = await deps.truelayer.extendConnection(current.accessToken, {
    refreshToken: current.connection.refreshToken,
    redirectUri: deps.redirectUri,
    // id, name and an email: TrueLayer's reference lists all three, and we
    // were sending only the id. Whether an incomplete user is why prod
    // extended nothing is unproven — but it is the difference between what
    // the reference asks for and what we send, and it costs nothing to close.
    user: { id: tenantId, name: tenantId, email: deps.contactEmail },
  });

  if (outcome.action !== "renewed") {
    return { consentId, action: outcome.action, continueAt: outcome.continueAt };
  }

  // The token first and on its own. Between the provider issuing a new refresh
  // token and this storing it, the connection is lost if anything fails — so
  // nothing else goes in front of it, and the consent date is a second write
  // rather than a reason to delay this one.
  //
  // `consentExpiresAt` is deliberately NOT taken from the token response. That
  // response carries `expires_in`, which is the ACCESS token's lifetime —
  // about an hour. Writing it here set three prod connections to "lapsed an
  // hour ago", which then made them unrenewable by the guard above. The
  // consent's own expiry is only known to `/me`, so it is read from there.
  // The token, and nothing else.
  //
  // `consentExpiresAt` is deliberately not written here. The token response
  // carries `expires_in`, which is the ACCESS token's lifetime — about an hour
  // — and writing that as the consent's expiry set three prod connections to
  // "lapsed an hour ago". The consent's real expiry is known only to `/me`,
  // and only some time later: TrueLayer applies the extension asynchronously,
  // so a `/me` fetched seconds after renewing still reports the old date.
  //
  // Measured on 4 October 2026: a consent renewed at 18:34:49Z still read
  // 14:06:34Z immediately afterwards, and read 18:34:49Z + 90 days on the next
  // sync. So there is no reading this renewal can take that is worth taking —
  // the daily sync owns this field, and the dashboard says so rather than
  // showing a figure that has not caught up.
  await deps.connections.update({
    ...current.connection,
    refreshToken: outcome.tokens.refreshToken,
  });

  return { consentId, action: "renewed" };
}

/** Both routes, against dependencies the caller supplies. */
export async function connectRoutes(deps: ConnectDeps, event: ConnectEvent) {
  const tenantId = event.requestContext?.authorizer?.jwt?.claims?.["custom:tenant"];
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    // Same rule as the read API: the household comes from a verified claim,
    // never from the request. Otherwise anyone signed in could attach a bank
    // connection to somebody else's ledger.
    return json(403, { error: "No household on this identity" });
  }

  const path = event.rawPath ?? "";
  const params = event.queryStringParameters ?? {};

  if (path.endsWith("/connect/start")) {
    // The tenant is carried in `state` so the callback knows whose connection
    // this is without trusting anything the browser sends back.
    const state = `${tenantId}:${randomUUID()}`;
    // A specific provider skips TrueLayer's picker of ninety banks. Restricted
    // to an allow-list so the parameter cannot be used to steer someone at an
    // arbitrary provider.
    const requested = params["provider"];

    // A value that is not a provider at all is ignored, not reported. This
    // parameter steers where somebody types their bank credentials, and the
    // safe response to a hostile one is the default picker rather than an
    // error page that confirms what was tried.
    const known = requested !== undefined && ALLOWED_PROVIDERS.includes(requested);

    // A *known* provider that cannot exist here is different, and is refused
    // with the reason. Measured on 4 October 2026: dev offered First Direct
    // against the sandbox, this accepted it because it is a real provider
    // somewhere, the Lambda logged a clean success, and TrueLayer answered
    // the redirect with a bare bad request — leaving the household on
    // somebody else's error page with nothing tying it to what they clicked.
    if (known && !providersForEnvironment(deps.sandbox).includes(requested)) {
      return json(400, {
        error:
          `${requested} does not exist in the ${deps.sandbox ? "sandbox" : "live"} environment. ` +
          `This deployment can offer: ${providersForEnvironment(deps.sandbox).join(", ")}`,
      });
    }

    const providers = known ? requested : deps.providers;
    return json(200, {
      url: authorisationUrl(deps.clientId, { ...deps, providers }, state, deps.authBase),
      state,
    });
  }

  if (path.endsWith("/connect/callback")) {
    const code = params["code"];
    const error = params["error"];
    if (error) return json(400, { error });
    if (!code) return json(400, { error: "No authorisation code" });

    try {
      const result = await completeConnect(deps, { tenantId, code });

      // Start the first sync NOW, and do not wait for it.
      //
      // The deep-history window is open at this moment and shuts within the
      // hour. Leaving it to the daily schedule would quietly reduce a new
      // connection to 90 days of history — the failure would look like nothing
      // at all until someone noticed the charts were short. Starting the state
      // machine returns to the browser at once while the fetch runs with
      // per-account retries behind it.
      await deps.startSync?.(result.connectionId);

      return json(200, result);
    } catch (err) {
      if (err instanceof TrueLayerError) {
        return json(400, { error: `Provider rejected the code (${err.status} ${err.code ?? ""})` });
      }
      throw err;
    }
  }

  if (path.endsWith("/connections/reconfirm")) {
    if (!deps.ownsConnections) {
      // 403 rather than 404: the route exists and the request was well formed.
      // Saying "not here" would send somebody looking for a deployment bug.
      return json(403, {
        error: "This deployment does not own the household's connections and may not renew them",
      });
    }

    const body = parseBody(event);
    const parsed = ReconfirmConnectionRequest.safeParse(body);
    if (!parsed.success) return json(400, { error: "A consentId is required" });

    try {
      return json(200, await reconfirmConnection(deps, tenantId, parsed.data.consentId));
    } catch (err) {
      if (err instanceof ConsentNotRenewable) return json(409, { error: err.message });
      if (err instanceof ConsentUnknown) return json(404, { error: err.message });
      if (err instanceof TrueLayerError) {
        return json(502, { error: `Provider refused the renewal (${err.status} ${err.code ?? ""})` });
      }
      throw err;
    }
  }

  return json(404, { error: `No route for ${path}` });
}

/**
 * Lambda entry point for both routes, and the only place a client is
 * constructed.
 *
 * Built per invocation rather than cached, matching `steps-handler.ts` and the
 * code this replaced: the dependencies include the TrueLayer application
 * secret, and caching it across warm invocations would mean a rotated secret
 * was not picked up until the next cold start.
 */
export async function handler(event: ConnectEvent) {
  return connectRoutes(await realConnectDeps(), event);
}

/**
 * The request body, or undefined.
 *
 * API Gateway hands a string, base64-encoded when it decides to. Parsing
 * failures are undefined rather than thrown: the caller validates the shape
 * anyway and a malformed body is a 400 either way.
 */
function parseBody(event: ConnectEvent): unknown {
  const raw = event.body;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(event.isBase64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw);
  } catch {
    return undefined;
  }
}

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
