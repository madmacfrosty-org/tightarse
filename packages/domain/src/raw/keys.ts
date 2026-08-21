/**
 * How the raw landing zone is laid out.
 *
 * Provider-shaped and permanent: every response is kept so the ledger can be
 * rebuilt from it, and these names are what a replay reads to know what it is
 * looking at.
 */

// ---------------------------------------------------------------- raw objects

/**
 * Which dataset a provider response belongs to.
 *
 * "dataset" collapses what used to be two segments — layer and endpoint. They
 * were the same idea: this identifies the shape, and the namespace prefix
 * carries where it came from. Curated datasets (`ledger.*`) conform to our
 * schema rather than a provider's, which is why "endpoint" was the wrong word.
 */
export function datasetForEndpoint(endpoint: string): string {
  const p = endpoint
    .replace(/^\/data\/v1\//, "")
    .replace(/\/[0-9a-f]{32}/g, "/{id}");

  const map: Record<string, string> = {
    "me": "truelayer.me",
    "info": "truelayer.info",
    "accounts": "truelayer.accounts",
    "accounts/{id}": "truelayer.account",
    "accounts/{id}/balance": "truelayer.balance",
    "accounts/{id}/transactions": "truelayer.transactions",
    "accounts/{id}/transactions/pending": "truelayer.transactions_pending",
    "accounts/{id}/direct_debits": "truelayer.direct_debits",
    "accounts/{id}/standing_orders": "truelayer.standing_orders",
    "cards": "truelayer.cards",
    "cards/{id}": "truelayer.card",
    "cards/{id}/balance": "truelayer.card_balance",
    "cards/{id}/transactions": "truelayer.card_transactions",
    "cards/{id}/transactions/pending": "truelayer.card_transactions_pending",
  };

  const dataset = map[p];
  if (!dataset) throw new Error(`No dataset mapping for endpoint ${endpoint}`);
  return dataset;
}

/**
 * S3 key for a raw provider response.
 *
 *   tenant=<t>/dataset=<source>.<name>/account=<a>/<compactIso>-<hash>.json.gz
 *
 * Tenant leads so that erasure is a single prefix delete covering every
 * dataset and layer, and so one IAM condition can scope a principal to one
 * household. There is deliberately no date partition: the fetch date is not
 * the transaction date, the distinction invites misreading, and at this volume
 * it bought nothing — the filename carries the timestamp and S3 lists keys
 * lexicographically, so ordering is preserved anyway.
 *
 * The hash is of the response body, so re-uploading identical content lands on
 * the same key rather than accumulating duplicates.
 */
export function rawObjectKey(args: {
  tenantId: string;
  dataset: string;
  accountId?: string | undefined;
  fetchedAt: string;
  contentHash: string;
}): string {
  const compact = args.fetchedAt.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const parts = [`tenant=${args.tenantId}`, `dataset=${args.dataset}`];
  if (args.accountId) parts.push(`account=${args.accountId}`);
  parts.push(`${compact}-${args.contentHash.slice(0, 12)}.json.gz`);
  return parts.join("/");
}

/**
 * Inverse of {@link rawObjectKey}.
 *
 * The transform is handed a key by an S3 event and has to know which household
 * and dataset it is looking at before it can parse the body. Reading it back
 * out of the key keeps that decision in one place rather than duplicating the
 * convention in every consumer.
 */
export function parseRawKey(key: string): {
  tenantId: string;
  dataset: string;
  accountId?: string;
  filename: string;
} {
  const segments = key.split("/");
  const get = (prefix: string): string | undefined => {
    const seg = segments.find((s) => s.startsWith(`${prefix}=`));
    return seg?.slice(prefix.length + 1);
  };

  const tenantId = get("tenant");
  const dataset = get("dataset");
  if (!tenantId || !dataset) {
    throw new Error(`Not a raw object key: ${key}`);
  }

  const accountId = get("account");
  return {
    tenantId,
    dataset,
    ...(accountId ? { accountId } : {}),
    // split() always yields at least one element, so this cannot be undefined.
    // The assertion is noUncheckedIndexedAccess being satisfied rather than a
    // claim about the data; a `?? ""` here would be a branch nothing can take.
    filename: segments[segments.length - 1]!,
  };
}
