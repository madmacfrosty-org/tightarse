import { randomUUID } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { TrueLayerClient, LIVE, SANDBOX, TrueLayerError } from "@tightarse/truelayer";
import { Connections, consentExpiry, type Connection } from "./connections.js";

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
export const ALLOWED_PROVIDERS = ["ob-first-direct", "ob-amex", "uk-ob-all uk-oauth-all"];

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
  const sm = new SecretsManagerClient({});
  const raw = await sm.send(
    new GetSecretValueCommand({ SecretId: required("CLIENT_SECRET_ID") }),
  );
  const creds = JSON.parse(raw.SecretString ?? "{}") as { clientId: string; clientSecret: string };
  const sandbox = process.env["TL_ENV"] === "sandbox";
  const machine = process.env["SYNC_STATE_MACHINE_ARN"];

  return {
    truelayer: new TrueLayerClient(creds, sandbox ? SANDBOX : LIVE),
    connections: new Connections(required("CONNECTION_SECRET_PREFIX"), sm),
    redirectUri: required("CONNECT_REDIRECT_URI"),
    providers: process.env["TL_PROVIDERS"] ?? "uk-ob-all uk-oauth-all",
    clientId: creds.clientId,
    authBase: sandbox ? SANDBOX.auth : LIVE.auth,
    ...(machine
      ? {
          startSync: async (connectionId: string) => {
            await new SFNClient({}).send(
              new StartExecutionCommand({
                stateMachineArn: machine,
                name: `connect-${connectionId}`.slice(0, 80),
                // Only the connection just made. Its deep-history window is the
                // one that shuts within the hour; the others are synced on
                // schedule and have their own rate limits to protect.
                input: JSON.stringify({ connectionId }),
              }),
            );
          },
        }
      : {}),
  };
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
    const providers =
      requested && ALLOWED_PROVIDERS.includes(requested) ? requested : deps.providers;
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

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
