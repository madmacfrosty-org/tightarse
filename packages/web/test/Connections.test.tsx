import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pathFor } from "@tightarse/api-contract";
import type { Parses } from "../src/ports";
import { Connections } from "../src/Connections";

/**
 * Every institution, id and date below is invented. This repository is public.
 */
const consent = (over: Record<string, unknown> = {}) => ({
  consentId: "c-1",
  institutionName: "Example Bank",
  expiresAt: "2026-11-06T00:00:00.000Z",
  fetchedAt: "2026-09-27T05:00:00.000Z",
  providerStatus: "Authorised",
  daysRemaining: 40,
  health: "ok",
  ...over,
});

const apiGet = vi.fn(async (_p: string): Promise<unknown> => ({ accounts: [], consents: [] }));
const apiPost = vi.fn(async (_p: string, _b: unknown): Promise<unknown> => ({
  consentId: "c-1",
  removedAt: "2026-09-27T12:00:00.000Z",
}));
const api = {
  get: <T,>(schema: Parses<T>, p: string) =>
    apiGet(p).then((body: unknown) => schema.parse(body)),
  post: <T,>(schema: Parses<T>, p: string, b: unknown) =>
    apiPost(p, b).then((body: unknown) => schema.parse(body)),
};

const withConsents = (consents: unknown[]) => {
  apiGet.mockImplementation(async (p: string) => {
    if (p.startsWith(pathFor("/accounts"))) return { accounts: [], consents };
    throw new Error(`unexpected path ${p}`);
  });
};

describe("the connections list", () => {
  it("names every bank and how long its consent has left", async () => {
    withConsents([consent()]);
    render(<Connections api={api} />);

    expect(await screen.findByText("Example Bank")).toBeDefined();
    expect(screen.getByText(/40 days left/)).toBeDefined();
  });

  it("says when we last heard, not only what was said", async () => {
    // "Authorised" is what the provider said the last time we asked. A
    // connection nothing syncs keeps reporting the last answer it got, so a
    // page showing only the status would make it indistinguishable from one
    // that refreshed this morning.
    withConsents([consent({ health: "stale", providerStatus: "Authorised" })]);
    render(<Connections api={api} />);

    expect(await screen.findByText(/not reporting in/i)).toBeDefined();
    expect(screen.getByText("Authorised")).toBeDefined();
  });

  it("puts what needs attention first, not what is alphabetically first", async () => {
    withConsents([
      consent({ consentId: "a", institutionName: "Healthy Bank", health: "ok", daysRemaining: 60 }),
      consent({ consentId: "b", institutionName: "Lapsed Bank", health: "expired", daysRemaining: 0 }),
      consent({ consentId: "c", institutionName: "Quiet Bank", health: "stale", daysRemaining: 40 }),
    ]);
    render(<Connections api={api} />);

    await screen.findByText("Healthy Bank");
    const order = [...document.querySelectorAll("tbody tr")].map(
      (r) => r.querySelector("td")!.textContent,
    );
    expect(order).toEqual(["Lapsed Bank", "Quiet Bank", "Healthy Bank"]);
  });

  it("says a lapsed consent has lapsed rather than counting below zero", async () => {
    withConsents([consent({ health: "expired", daysRemaining: -3 })]);
    render(<Connections api={api} />);

    await screen.findByText("Example Bank");
    // Both the duration and the health word read "Lapsed" here, which is the
    // point: neither says "-3 days".
    expect(document.body.textContent).not.toContain("-3 days");
    expect(document.body.textContent).toContain("Lapsed");
  });

  it("says so when there is nothing connected", async () => {
    withConsents([]);
    render(<Connections api={api} />);

    expect(await screen.findByText(/no bank is connected/i)).toBeDefined();
  });

  it("reports a failure rather than an empty list", async () => {
    // An empty list and a failed read look identical to a reader, and one of
    // them means the household has no idea whether its feed is alive.
    apiGet.mockRejectedValue(new Error("nope"));
    render(<Connections api={api} />);

    await waitFor(() =>
      expect(screen.getByText(/could not read the connections/i)).toBeDefined(),
    );
  });

  it("says when the connection data itself was last refreshed", async () => {
    // One line for the panel, not a column. It answers "did this morning's
    // sync happen", which is a different question from "is this connection
    // alive" — that one each row answers for itself.
    withConsents([
      consent({ consentId: "a", fetchedAt: "2026-09-20T05:00:00.000Z" }),
      consent({ consentId: "b", fetchedAt: "2026-09-27T05:00:00.000Z" }),
    ]);
    render(<Connections api={api} />);

    // The newest, because the sync asks about every connection in one run — so
    // the most recent answer is when the run last succeeded. Taking the oldest
    // would report a frozen connection as the age of the whole feed.
    const line = await screen.findByText(/last refreshed at/i);
    expect(line.textContent).toContain("27 Sept 2026");
    expect(line.textContent).not.toContain("20 Sept");
  });

  
  
  
  });

/**
 * Renewing a connection.
 *
 * `loadConfig` is mocked because the control's visibility is a fact about the
 * deployment, and the component asks for it. Without the mock every test here
 * runs against a failed config read — which hides the button and would let all
 * of this pass while testing nothing.
 */


describe("suspending and resuming a connection", () => {
  /*
   * This replaces a Remove button that wrote the consent row and nothing
   * else. The sync lists connection secrets, which knew nothing about it, so
   * a "removed" connection vanished from the page and went on syncing every
   * morning — spending the provider allowance and reporting the same problem
   * for ever.
   */
  it("is offered on a healthy connection, which is the case that matters", async () => {
    // Reconnecting a bank leaves the old one live and duplicating the new.
    // The old button refused anything still working, so tidying up meant
    // waiting ninety days for it to lapse.
    withConsents([consent({ health: "ok" })]);
    render(<Connections api={api} />);
    await screen.findByText("Example Bank");

    const button = screen.getByRole("button", { name: /suspend/i });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("asks the server to stop syncing it, and re-reads", async () => {
    // Re-read rather than patch: suspending changes what the sync will do,
    // and the server is what knows it.
    withConsents([consent({ consentId: "c-1", health: "ok" })]);
    render(<Connections api={api} />);
    await screen.findByText("Example Bank");

    await userEvent.click(screen.getByRole("button", { name: /suspend/i }));

    await waitFor(() =>
      expect(apiPost.mock.calls.at(-1)?.[1]).toEqual({ consentId: "c-1", suspended: true }),
    );
  });

  it("offers Resume on one already suspended, not Suspend again", async () => {
    withConsents([consent({ health: "stale", suspendedAt: "2026-10-30T12:00:00.000Z" })]);
    render(<Connections api={api} />);
    await screen.findByText("Example Bank");

    expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^suspend$/i })).toBeNull();
  });

  it("asks the server to start it again", async () => {
    withConsents([
      consent({ consentId: "c-1", health: "stale", suspendedAt: "2026-10-30T12:00:00.000Z" }),
    ]);
    render(<Connections api={api} />);
    await screen.findByText("Example Bank");

    await userEvent.click(screen.getByRole("button", { name: /resume/i }));

    await waitFor(() =>
      expect(apiPost.mock.calls.at(-1)?.[1]).toEqual({ consentId: "c-1", suspended: false }),
    );
  });

  it("reports a refusal rather than quietly leaving the row", async () => {
    // The row must stay on screen with the reason. Dropping it and then
    // failing would leave the household believing it had stopped.
    withConsents([consent({ health: "ok" })]);
    render(<Connections api={api} />);
    await screen.findByText("Example Bank");

    apiPost.mockImplementationOnce(() => Promise.reject(new Error("no such connection")));
    await userEvent.click(screen.getByRole("button", { name: /suspend/i }));

    await waitFor(() => expect(screen.getByText(/no such connection/i)).toBeDefined());
    expect(document.body.textContent).toContain("Example Bank");
  });
});
