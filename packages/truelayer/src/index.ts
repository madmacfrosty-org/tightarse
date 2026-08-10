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
   * The provider does not offer this endpoint for this account. First Direct
   * returns 501 for standing orders on every account and 403 for direct debits
   * on accounts that have none — neither is a failure to retry.
   */
  get isNotApplicable(): boolean {
    return this.status === 501 || this.status === 403;
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

/** The endpoints a sync fetches, and whether a failure is fatal. */
export interface EndpointSpec {
  readonly path: (accountId: string) => string;
  readonly dataset: string;
  /** Per-account, or once per connection. */
  readonly perAccount: boolean;
  /**
   * When true, a 403 or 501 is recorded and skipped rather than failing the
   * sync — the provider simply does not offer it for that account.
   */
  readonly optional: boolean;
}

export const ENDPOINTS: readonly EndpointSpec[] = [
  { path: () => "/data/v1/accounts", dataset: "truelayer.accounts", perAccount: false, optional: false },
  { path: (a) => `/data/v1/accounts/${a}/balance`, dataset: "truelayer.balance", perAccount: true, optional: false },
  { path: (a) => `/data/v1/accounts/${a}/transactions/pending`, dataset: "truelayer.transactions_pending", perAccount: true, optional: true },
  { path: (a) => `/data/v1/accounts/${a}/direct_debits`, dataset: "truelayer.direct_debits", perAccount: true, optional: true },
  { path: (a) => `/data/v1/accounts/${a}/standing_orders`, dataset: "truelayer.standing_orders", perAccount: true, optional: true },
];

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
