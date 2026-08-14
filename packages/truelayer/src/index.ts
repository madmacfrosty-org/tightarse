/**
 * TrueLayer Data API client.
 *
 * Behind a narrow interface on purpose: GoCardless Bank Account Data is the
 * fallback if TrueLayer's commercial terms stop suiting a household-scale
 * application, and nothing outside this package should know which provider is
 * in use.
 *
 * Everything here was shaped by measurement against First Direct, not by the
 * documentation — where the two disagreed, the observed behaviour won and the
 * difference is noted at the point it matters.
 */

export interface TrueLayerEnvironment {
  readonly auth: string;
  readonly api: string;
}

export const LIVE: TrueLayerEnvironment = {
  auth: "https://auth.truelayer.com",
  api: "https://api.truelayer.com",
};

export const SANDBOX: TrueLayerEnvironment = {
  auth: "https://auth.truelayer-sandbox.com",
  api: "https://api.truelayer-sandbox.com",
};

export interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute expiry, so a stored token can be judged without knowing when it
   *  was issued. */
  readonly expiresAt: string;
}

/**
 * The deepest history the provider will serve in one request.
 *
 * Measured, not assumed: 72 months and beyond return 400 `invalid_date_range`
 * instantly — a validation rejection, not a data lookup — while 60 months
 * returns in about 14 seconds for a 9,000-transaction account.
 */
export const MAX_HISTORY_MONTHS = 60;

/**
 * The widest window unattended access may ask for, in days.
 *
 * Once the SCA exemption lapses a bank returns at most 90 days, and refuses
 * anything longer with 403 access_denied on the whole call rather than
 * truncating it. Counted in days deliberately: three calendar months is 89 to
 * 92 depending on where you start, and the first attempt at this fix asked for
 * 13 May to 13 August — 92 days — and was refused for being two days greedy.
 *
 * 88 rather than 90 because providers under-deliver even inside the limit;
 * Monzo is documented as returning 88.
 */
export const UNATTENDED_HISTORY_DAYS = 88;

/**
 * The narrowest routine window.
 *
 * A daily sync only needs the last day, but pending rows settle over several
 * days and card transactions frequently arrive dated earlier than they appear.
 * A window that starts exactly where the last one ended loses those for ever,
 * so the floor buys about a week of overlap for nothing.
 */
export const MIN_SYNC_DAYS = 10;

/** Added to a measured gap, for the same late-arrival reason. */
export const SYNC_OVERLAP_DAYS = 3;

/**
 * How long the deep-history exemption lasts after consent.
 *
 * Documented as about an hour. Treated as slightly less, because asking for
 * sixty months a minute after it closes costs the whole run rather than
 * degrading to ninety days.
 */
export const DEEP_HISTORY_WINDOW_MINUTES = 45;

const DAY_MS = 86_400_000;

export interface SyncWindow {
  /** Inclusive start, YYYY-MM-DD. */
  from: string;
  /** Inclusive end, YYYY-MM-DD. */
  to: string;
  /** True while the SCA exemption still allows the full history. */
  deepHistory: boolean;
}

/**
 * The date range to request for one connection.
 *
 * Inside the exemption window, everything the bank will give — this is the only
 * moment it is available and it does not come back. After that, enough to cover
 * the gap since the last SUCCESSFUL sync, plus overlap, bounded at both ends.
 *
 * `lastSyncedAt` absent means nothing has ever been fetched, so it asks for the
 * widest window allowed rather than the narrowest: a connection that has never
 * worked has the most to catch up on, not the least.
 */
export function syncWindow(
  connection: { connectedAt: string; lastSyncedAt?: string | undefined },
  now = new Date(),
): SyncWindow {
  const to = now.toISOString().slice(0, 10);
  const age = now.getTime() - Date.parse(connection.connectedAt);

  if (age <= DEEP_HISTORY_WINDOW_MINUTES * 60_000) {
    return { from: historyFrom(MAX_HISTORY_MONTHS, now), to, deepHistory: true };
  }

  const gapDays = connection.lastSyncedAt
    ? (now.getTime() - Date.parse(connection.lastSyncedAt)) / DAY_MS + SYNC_OVERLAP_DAYS
    : UNATTENDED_HISTORY_DAYS;

  const days = Math.min(UNATTENDED_HISTORY_DAYS, Math.max(MIN_SYNC_DAYS, Math.ceil(gapDays)));
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10), to, deepHistory: false };
}

export class TrueLayerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "TrueLayerError";
  }

  /**
   * The consent has lapsed and cannot be refreshed. The only remedy is the
   * household reconnecting at the bank, so this must surface to a human rather
   * than be retried.
   */
  get isConsentExpired(): boolean {
    return this.code === "invalid_grant" || (this.status === 403 && this.code === "access_denied");
  }

  /**
   * The provider does not offer this endpoint here. First Direct returns 501
   * for standing orders on every account and 403 for direct debits on accounts
   * that have none; a path that does not exist for a resource returns 404.
   * None is a failure worth retrying, and treating 404 as one cost five
   * redundant fetches of an entire Amex card before the step gave up.
   */
  get isNotApplicable(): boolean {
    return this.status === 501 || this.status === 403 || this.status === 404;
  }
}

export class TrueLayerClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly env: TrueLayerEnvironment = LIVE,
  ) {}

  /** Exchange an authorisation code for a token set. */
  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    return this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
  }

  /**
   * Refresh an access token.
   *
   * TrueLayer may return a NEW refresh token, and the old one stops working.
   * Callers must persist whatever comes back — keeping the original is how a
   * connection silently dies days later.
   */
  /**
   * Data calls made by this client.
   *
   * Unattended access is capped at four per 24 hours per consent, and a run
   * that quietly spends five is the failure that cost a card five redundant
   * fetches. A client is built once per Lambda invocation, so this is the count
   * for one step; the outcome step totals them.
   *
   * Token refreshes are not counted: they are not data calls and do not count
   * against the cap.
   */
  get calls(): number {
    return this.callsMade;
  }

  private callsMade = 0;

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async token(params: Record<string, string>): Promise<TokenSet> {
    const res = await fetch(`${this.env.auth}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        ...params,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (!res.ok || !body.access_token) {
      throw new TrueLayerError(
        `Token request failed: ${res.status}`,
        res.status,
        body.error ?? null,
      );
    }
    if (!body.refresh_token) {
      throw new TrueLayerError(
        "No refresh token returned — check the offline_access scope",
        res.status,
        null,
      );
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    };
  }

  /** A raw GET against the Data API, returning the complete response envelope. */
  async get(accessToken: string, path: string): Promise<{ status: number; body: unknown }> {
    // Counted before the call, not after, so a request that fails still spends
    // its share of the allowance — which is exactly what the provider does.
    this.callsMade += 1;
    const res = await fetch(`${this.env.api}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const code = (body as { error?: string } | null)?.error ?? null;
      throw new TrueLayerError(`GET ${path} failed: ${res.status}`, res.status, code);
    }
    return { status: res.status, body };
  }
}

/**
 * A provider may expose accounts, cards, or only one of the two.
 *
 * Amex is cards-only — its scopes are `info, cards, balance, transactions`
 * with no `accounts` at all. Treating `/data/v1/accounts` as mandatory would
 * abort an Amex sync before it fetched anything.
 */
export type Resource = "accounts" | "cards";

export const RESOURCES: readonly Resource[] = ["accounts", "cards"];

/** Per-resource endpoints fetched for every account or card found. */
export interface EndpointSpec {
  readonly suffix: string;
  readonly dataset: (resource: Resource) => string;
  /**
   * When true, a 403 or 501 is recorded and skipped rather than failing the
   * sync — the provider simply does not offer it here.
   */
  readonly optional: boolean;
  /**
   * Which resources this endpoint exists for.
   *
   * Direct debits and standing orders are account concepts; the card paths do
   * not exist and return 404. Calling them anyway failed the whole per-item
   * step, which then retried four times, re-fetching transactions and balances
   * on every attempt and burning calls against the four-per-24-hours cap.
   */
  readonly resources: readonly Resource[];
}

const singular: Record<Resource, string> = { accounts: "account", cards: "card" };

export const PER_ITEM_ENDPOINTS: readonly EndpointSpec[] = [
  {
    suffix: "balance",
    dataset: (r) => (r === "cards" ? "truelayer.card_balance" : "truelayer.balance"),
    optional: false,
    resources: ["accounts", "cards"],
  },
  {
    suffix: "transactions/pending",
    dataset: (r) => (r === "cards" ? "truelayer.card_transactions_pending" : "truelayer.transactions_pending"),
    optional: true,
    resources: ["accounts", "cards"],
  },
  {
    suffix: "direct_debits",
    dataset: () => "truelayer.direct_debits",
    optional: true,
    resources: ["accounts"],
  },
  {
    suffix: "standing_orders",
    dataset: () => "truelayer.standing_orders",
    optional: true,
    resources: ["accounts"],
  },
];

/** Dataset name for the list endpoint of a resource. */
export function listDataset(resource: Resource): string {
  return `truelayer.${resource}`;
}

/** Dataset name for a resource's transactions. */
export function transactionsDataset(resource: Resource): string {
  return resource === "cards" ? "truelayer.card_transactions" : "truelayer.transactions";
}

/** Dataset name for a single item's detail. */
export function itemDataset(resource: Resource): string {
  return `truelayer.${singular[resource]}`;
}

/**
 * ISO date `months` before `now`, for a transactions query.
 *
 * Clamps to the last day of the target month rather than letting the date
 * overflow. `setMonth` alone turns "one month before 31 March" into 3 March,
 * because 31 February rolls forward — a silent three-day gap in a fetch window,
 * and exactly the kind of date bug that is never noticed until reconciliation
 * disagrees.
 */
export function historyFrom(months: number, now = new Date()): string {
  const day = now.getUTCDate();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d.toISOString().slice(0, 10);
}
