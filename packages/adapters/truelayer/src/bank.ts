/**
 * TrueLayer as a `BankData` adapter.
 *
 * Everything provider-specific that used to live in `services/ingest/src/steps.ts`
 * is here: the `/data/v1/...` URLs, which endpoints exist for which resource,
 * the dataset names the raw zone is keyed by, and the classification of what
 * TrueLayer refuses.
 *
 * That last one is the point. The sync step used to ask
 * `err instanceof TrueLayerError && err.isNotApplicable` at three sites, so a
 * second provider meant editing the step rather than writing one of these. Now
 * the step sees two outcomes: a payload it lands, or a name in `skipped`. The one
 * exception is `ConsentExpired`, which is in the port because only a person can
 * fix it and no amount of retrying will.
 */

import type { BankData, BankItem, BankLimits, BankPayload, BankToken, DateRange } from "@tightarse/domain";
import { ConsentExpired } from "@tightarse/domain";
import {
  DEEP_HISTORY_WINDOW_MINUTES,
  LIVE,
  MAX_HISTORY_MONTHS,
  PER_ITEM_ENDPOINTS,
  RESOURCES,
  TrueLayerClient,
  TrueLayerError,
  UNATTENDED_HISTORY_DAYS,
  itemDataset,
  listDataset,
  transactionsDataset,
  type Credentials,
  type Resource,
  type TrueLayerEnvironment,
} from "./index.js";

export class TrueLayerBank implements BankData {
  private readonly client: TrueLayerClient;

  constructor(credentials: Credentials, environment: TrueLayerEnvironment = LIVE, client?: TrueLayerClient) {
    this.client = client ?? new TrueLayerClient(credentials, environment);
  }

  readonly limits: BankLimits = {
    maxHistoryMonths: MAX_HISTORY_MONTHS,
    unattendedHistoryDays: UNATTENDED_HISTORY_DAYS,
    exemptionMinutes: DEEP_HISTORY_WINDOW_MINUTES,
  };

  get calls(): number {
    return this.client.calls;
  }

  async refresh(refreshToken: string): Promise<BankToken> {
    try {
      return await this.client.refresh(refreshToken);
    } catch (err) {
      // invalid_grant on a refresh means the consent has lapsed. Reported as a
      // provider-neutral failure so the step can tell a human without knowing
      // whose error code it was.
      if (err instanceof TrueLayerError && err.isConsentExpired) {
        throw new ConsentExpired(err.message);
      }
      throw err;
    }
  }

  async listItems(accessToken: string): Promise<{
    items: BankItem[];
    payloads: BankPayload[];
    skipped: string[];
  }> {
    const items: BankItem[] = [];
    const payloads: BankPayload[] = [];
    const skipped: string[] = [];

    // Connection metadata, every run. It carries the provider's own word on
    // when this consent lapses, and a consent row is only worth anything if it
    // is refreshed: a lapsed consent cannot be refreshed at all, so a row that
    // has stopped moving is the signal the feed has died. Fetched once at
    // connect and never again, every consent would read as long dead within two
    // days of being granted.
    //
    // One call per connection per run. Unattended access allows four per
    // account, endpoint and consent per 24 hours and the sync runs daily, so
    // this is comfortably inside it — but it is a budget, and anything that
    // starts calling `listItems` more than once a day has to count again.
    //
    // Its own try, outside the resource loop: `me` is not a resource and its
    // absence must not look like a provider offering cards and no accounts.
    try {
      const res = await this.client.get(accessToken, "/data/v1/me");
      payloads.push({ dataset: "truelayer.me", itemId: null, body: res.body });
    } catch (err) {
      // A connection that cannot describe itself is still a connection whose
      // transactions are worth fetching. The consent row goes stale, which is
      // what stale is for.
      if (!(err instanceof TrueLayerError && err.isNotApplicable)) throw err;
      skipped.push("me");
    }

    for (const resource of RESOURCES) {
      try {
        const res = await this.client.get(accessToken, `/data/v1/${resource}`);
        payloads.push({ dataset: listDataset(resource), itemId: null, body: res.body });
        for (const a of (res.body as { results?: Array<{ account_id?: string }> }).results ?? []) {
          if (a.account_id) items.push({ resource, itemId: a.account_id });
        }
      } catch (err) {
        // A provider may offer only one of the two — Amex is cards-only, with no
        // accounts scope at all. A missing resource is a shape, not a failure.
        if (err instanceof TrueLayerError && err.isNotApplicable) {
          skipped.push(resource);
          continue;
        }
        throw err;
      }
    }

    return { items, payloads, skipped };
  }

  async fetchItem(
    accessToken: string,
    item: BankItem,
    window: DateRange,
  ): Promise<{ payloads: BankPayload[]; skipped: string[]; transactions: number }> {
    const resource = item.resource as Resource;
    const { itemId } = item;
    const payloads: BankPayload[] = [];
    const skipped: string[] = [];

    // Transactions first: they are the point of the exercise.
    const txRes = await this.client.get(
      accessToken,
      `/data/v1/${resource}/${itemId}/transactions?from=${window.from}&to=${window.to}`,
    );
    payloads.push({
      dataset: transactionsDataset(resource),
      itemId,
      body: txRes.body,
      window,
    });
    const transactions = ((txRes.body as { results?: unknown[] }).results ?? []).length;

    const detail = await this.client.get(accessToken, `/data/v1/${resource}/${itemId}`);
    payloads.push({ dataset: itemDataset(resource), itemId, body: detail.body });

    for (const spec of PER_ITEM_ENDPOINTS) {
      if (!spec.resources.includes(resource)) continue;
      const dataset = spec.dataset(resource);
      try {
        const res = await this.client.get(accessToken, `/data/v1/${resource}/${itemId}/${spec.suffix}`);
        payloads.push({ dataset, itemId, body: res.body });
      } catch (err) {
        if (spec.optional && err instanceof TrueLayerError && err.isNotApplicable) {
          // First Direct returns 501 for standing orders everywhere and 403 for
          // direct debits on accounts that have none. Alarming on those trains
          // everyone to ignore alarms.
          skipped.push(`${dataset} ${itemId}`);
          continue;
        }
        throw err;
      }
    }

    return { payloads, skipped, transactions };
  }
}
