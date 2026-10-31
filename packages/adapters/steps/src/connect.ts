import { randomUUID } from "node:crypto";
import { TrueLayerClient, LIVE, SANDBOX, TrueLayerError } from "@tightarse/truelayer";
import { Connections, consentExpiry, type Connection } from "./connections.js";
import { AwsSecrets, startExecution } from "@tightarse/aws";
import { SuspendConnectionRequest } from "@tightarse/api-contract";
import {
  ConnectionNotFound,
  resumeConnection,
  suspendConnection,
  type Consent,
  type Row,
} from "@tightarse/domain";
import { DynamoStore } from "@tightarse/dynamodb";

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
  /** Whether this deployment talks to the sandbox. Decides which banks exist. */
  readonly sandbox: boolean;
  /**
   * The consent rows, which are what the dashboard shows.
   *
   * Suspending writes both this and the connection secret: the secret is what
   * the sync reads, and the row is what lets the page say a connection is
   * suspended rather than merely silent. Without the row it would go `stale`
   * after two days and read as broken.
   */
  readonly consents: {
    readonly list: (tenantId: string) => Promise<Row[]>;
    readonly put: (consent: Consent) => Promise<void>;
  };
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
  // The ledger, for the consent rows. Configured here rather than imported
  // from the read API's handler: this function has its own entry point and
  // borrowing another adapter's wiring is how two deployments end up
  // disagreeing about which table they mean.
  const store = new DynamoStore({
    tableName: required("TABLE_NAME"),
    region: process.env["AWS_REGION"] ?? "eu-west-1",
  });
  const stored = await secrets.get(required("CLIENT_SECRET_ID"));
  const creds = JSON.parse(stored ?? "{}") as { clientId: string; clientSecret: string };
  const sandbox = process.env["TL_ENV"] === "sandbox";
  const machine = process.env["SYNC_STATE_MACHINE_ARN"];

  return {
    truelayer: new TrueLayerClient(creds, sandbox ? SANDBOX : LIVE),
    connections: new Connections(required("CONNECTION_SECRET_PREFIX"), secrets),
    redirectUri: required("CONNECT_REDIRECT_URI"),
    providers: process.env["TL_PROVIDERS"] ?? "uk-ob-all uk-oauth-all",
    sandbox,
    consents: {
      list: (tenantId: string) => store.listConsents(tenantId),
      put: (consent: Consent) => store.putConsent(consent),
    },
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


  if (path.endsWith("/connections/suspend")) {
    const parsed = SuspendConnectionRequest.safeParse(parseBody(event));
    if (!parsed.success) return json(400, { error: "A consentId and suspended are required" });

    const store = {
      listConsents: deps.consents.list,
      putConsent: deps.consents.put,
      // The connection store, by the provider's own id. The link is written by
      // the sync from the `/me` it already fetches.
      setConnectionSuspended: async (tenantId: string, credentialsId: string, on: boolean) => {
        const found = await deps.connections.setSuspended(
          tenantId,
          credentialsId,
          on ? new Date().toISOString() : undefined,
        );
        // Not an error. A consent row can outlive the connection behind it —
        // the phantom this feature was first built for — and suspending one
        // must still mark the row so it stops being shown.
        if (!found) console.log(JSON.stringify({ event: "suspend.noConnection", credentialsId }));
      },
    };

    try {
      const out = parsed.data.suspended
        ? await suspendConnection(store, tenantId, parsed.data.consentId)
        : await resumeConnection(store, tenantId, parsed.data.consentId);
      return json(200, { consentId: out.consentId, ...("suspendedAt" in out ? out : {}) });
    } catch (err) {
      if (err instanceof ConnectionNotFound) return json(404, { error: err.message });
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
 * API Gateway hands a string, base64-encoded when it decides to. A parse
 * failure is undefined rather than a throw: the caller validates the shape
 * anyway, and a malformed body is a 400 either way.
 */
function parseBody(event: ConnectEvent): unknown {
  const raw = event.body;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(
      event.isBase64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw,
    );
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
