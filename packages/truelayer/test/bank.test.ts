import { describe, it, expect, vi } from "vitest";
import { ConsentExpired } from "@tightarse/domain";
import { TrueLayerBank } from "../src/bank.js";
import { SANDBOX, TrueLayerClient } from "../src/index.js";

/**
 * The provider knowledge that used to live in services/ingest/src/steps.ts.
 *
 * Which URLs, which endpoints exist for a card versus an account, what the
 * datasets are called, and which refusals are a shape rather than a failure. The
 * sync step asserted all of this through fake HTTP paths, which meant a change to
 * a URL failed a test about syncing. It belongs next to the client that builds
 * them.
 */

const creds = { clientId: "id", clientSecret: "secret" };

/** A TrueLayerClient over a fetch that answers per path. */
function bank(answer: (path: string) => unknown) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace(SANDBOX.api, "");
      paths.push(path);
      const body = answer(path);
      if (body instanceof Error) {
        const status = Number((body as Error & { status?: number }).status ?? 500);
        return { ok: false, status, json: async () => ({ error: "refused" }) };
      }
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  return { paths, subject: new TrueLayerBank(creds, SANDBOX, new TrueLayerClient(creds, SANDBOX)) };
}

const refuse = (status: number) => Object.assign(new Error("refused"), { status });

describe("limits it publishes", () => {
  it("states what was measured against the provider, not a guess", async () => {
    // 60 months is where the API starts returning invalid_date_range instantly;
    // 88 days is the unattended cap less the margin providers under-deliver by;
    // 45 minutes is the documented hour, treated as less because asking a minute
    // late costs the whole run rather than degrading.
    const { subject } = bank(() => ({ results: [] }));
    expect(subject.limits).toEqual({
      maxHistoryMonths: 60,
      unattendedHistoryDays: 88,
      exemptionMinutes: 45,
    });
  });
});

describe("listing what a connection holds", () => {
  it("asks for both resources and names each listing by its dataset", async () => {
    const { paths, subject } = bank(() => ({ results: [{ account_id: "a1" }] }));
    const out = await subject.listItems("token");
    expect(paths).toEqual(["/data/v1/accounts", "/data/v1/cards"]);
    expect(out.payloads.map((p) => p.dataset)).toEqual(["truelayer.accounts", "truelayer.cards"]);
    expect(out.payloads.every((p) => p.itemId === null)).toBe(true);
  });

  it("reports a resource the provider does not offer as skipped, not as a failure", async () => {
    // Amex is cards-only, with no accounts scope at all. Treating that as an
    // error aborts an Amex sync before it fetches anything.
    const { subject } = bank((p) => (p.endsWith("/accounts") ? refuse(403) : { results: [{ account_id: "c1" }] }));
    const out = await subject.listItems("token");
    expect(out.skipped).toEqual(["accounts"]);
    expect(out.items).toEqual([{ resource: "cards", itemId: "c1" }]);
  });

  it("lets a genuine failure through, so the state machine retries", async () => {
    const { subject } = bank(() => refuse(500));
    await expect(subject.listItems("token")).rejects.toThrow();
  });

  it("ignores an entry with no account id rather than inventing one", async () => {
    const { subject } = bank(() => ({ results: [{}, { account_id: "a1" }] }));
    expect(await subject.listItems("token")).toMatchObject({ items: [{ itemId: "a1" }, { itemId: "a1" }] });
  });
});

describe("fetching one item", () => {
  const window = { from: "2026-01-01", to: "2026-03-01" };

  it("asks for transactions first, with the window in the query", async () => {
    // They are the point of the exercise, and the window is what the provider
    // refuses outright when it is too wide.
    const { paths, subject } = bank(() => ({ results: [] }));
    await subject.fetchItem("token", { resource: "accounts", itemId: "acc-1" }, window);
    expect(paths[0]).toBe("/data/v1/accounts/acc-1/transactions?from=2026-01-01&to=2026-03-01");
  });

  it("never asks a card for direct debits or standing orders", async () => {
    // They are account concepts. The card paths return 404, which failed the
    // whole step, retried four times, and re-fetched transactions, detail and
    // balance on every attempt — five times the necessary calls against a cap of
    // four per 24 hours.
    const { paths, subject } = bank(() => ({ results: [] }));
    await subject.fetchItem("token", { resource: "cards", itemId: "card-1" }, window);
    expect(paths.some((p) => p.includes("direct_debits"))).toBe(false);
    expect(paths.some((p) => p.includes("standing_orders"))).toBe(false);
  });

  it("does ask an account for them", async () => {
    const { paths, subject } = bank(() => ({ results: [] }));
    await subject.fetchItem("token", { resource: "accounts", itemId: "acc-1" }, window);
    expect(paths.some((p) => p.includes("direct_debits"))).toBe(true);
    expect(paths.some((p) => p.includes("standing_orders"))).toBe(true);
  });

  it("skips an optional endpoint the provider refuses, rather than failing", async () => {
    // First Direct returns 501 for standing orders everywhere and 403 for direct
    // debits on accounts that have none. Alarming on those trains everyone to
    // ignore alarms.
    const { subject } = bank((p) =>
      p.includes("standing_orders") ? refuse(501) : p.includes("direct_debits") ? refuse(403) : { results: [] },
    );
    const out = await subject.fetchItem("token", { resource: "accounts", itemId: "acc-1" }, window);
    expect(out.skipped).toHaveLength(2);
    expect(out.payloads.length).toBeGreaterThan(0);
  });

  it("still fails when a required endpoint refuses", async () => {
    const { subject } = bank((p) => (p.includes("/transactions?") ? refuse(500) : { results: [] }));
    await expect(
      subject.fetchItem("token", { resource: "accounts", itemId: "acc-1" }, window),
    ).rejects.toThrow();
  });

  it("counts the transactions it saw, because nothing downstream can", async () => {
    // A current account doing thirty a day dropping to zero is a signal, and the
    // raw object is the only place it is visible.
    const { subject } = bank((p) => (p.includes("/transactions?") ? { results: [1, 2, 3] } : { results: [] }));
    const out = await subject.fetchItem("token", { resource: "accounts", itemId: "acc-1" }, window);
    expect(out.transactions).toBe(3);
  });

  it("records the window against the transactions payload and nothing else", async () => {
    // The raw object carries the range it was fetched for, which is what a replay
    // needs to know what it is and is not looking at.
    const { subject } = bank(() => ({ results: [] }));
    const out = await subject.fetchItem("token", { resource: "accounts", itemId: "acc-1" }, window);
    const withWindow = out.payloads.filter((p) => p.window !== undefined);
    expect(withWindow).toHaveLength(1);
    expect(withWindow[0]!.dataset).toBe("truelayer.transactions");
  });
});

describe("what only a person can fix", () => {
  it("reports a lapsed consent as ConsentExpired, not as the provider's error", async () => {
    // The one failure the application must tell apart: retrying is pointless and
    // reporting it as transient hides work only a human can do.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) })));
    const subject = new TrueLayerBank(creds, SANDBOX);
    await expect(subject.refresh("stale")).rejects.toBeInstanceOf(ConsentExpired);
  });

  it("lets any other refresh failure through unchanged", async () => {
    // A 500 is transient and the state machine should retry it. Mapping it to a
    // lapsed consent would send someone to re-authorise a working connection.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "server_error" }) })));
    const subject = new TrueLayerBank(creds, SANDBOX);
    await expect(subject.refresh("token")).rejects.not.toBeInstanceOf(ConsentExpired);
  });

  it("passes a rotated refresh token through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: "a", refresh_token: "rotated", expires_in: 3600 }),
    })));
    const subject = new TrueLayerBank(creds, SANDBOX);
    expect(await subject.refresh("old")).toMatchObject({ refreshToken: "rotated" });
  });
});

describe("call accounting", () => {
  it("reports what the underlying client spent", async () => {
    // Unattended access is four per account, endpoint and consent per 24 hours,
    // and it is a retry loop that breaches it.
    const { subject } = bank(() => ({ results: [] }));
    expect(subject.calls).toBe(0);
    await subject.listItems("token");
    expect(subject.calls).toBe(2);
  });
});
