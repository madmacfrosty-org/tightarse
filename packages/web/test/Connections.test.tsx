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

  it("offers Remove only on a connection that has stopped", async () => {
    // The guard is the disabled state, not a dialog. A live connection is
    // still feeding the ledger, and getting it back means re-authorising.
    withConsents([
      consent({ consentId: "live", institutionName: "Live Bank", health: "ok" }),
      consent({ consentId: "dead", institutionName: "Quiet Bank", health: "stale" }),
    ]);
    render(<Connections api={api} />);
    await screen.findByText("Live Bank");

    const buttons = screen.getAllByRole("button", { name: /remove/i });
    const [dead, live] = [buttons[0]!, buttons[1]!]; // stale sorts first
    expect(dead.hasAttribute("disabled")).toBe(false);
    expect(live.hasAttribute("disabled")).toBe(true);
  });

  it("says why it cannot be removed rather than leaving a dead control", async () => {
    withConsents([consent({ health: "ok" })]);
    render(<Connections api={api} />);
    await screen.findByText("Example Bank");

    expect(
      screen.getByRole("button", { name: /remove/i }).getAttribute("title"),
    ).toMatch(/still working/i);
  });

  it("stops listing one once it is removed", async () => {
    withConsents([
      consent({ consentId: "dead", institutionName: "Quiet Bank", health: "stale" }),
      consent({ consentId: "live", institutionName: "Live Bank", health: "ok" }),
    ]);
    render(<Connections api={api} />);
    await screen.findByText("Quiet Bank");

    await userEvent.click(screen.getAllByRole("button", { name: /remove/i })[0]!);

    await waitFor(() => expect(screen.queryByText("Quiet Bank")).toBeNull());
    // Only the one asked for. The row is still stored — this is the list
    // ceasing to show it, not the record going.
    expect(screen.getByText("Live Bank")).toBeDefined();
    expect(apiPost.mock.calls[0]?.[1]).toEqual({ consentId: "dead" });
  });

  it("reports a refusal instead of quietly leaving the row", async () => {
    // A connection the server refuses to remove must stay on screen with the
    // reason. Dropping the row optimistically and then failing would leave the
    // household believing it had gone.
    withConsents([consent({ consentId: "dead", health: "stale" })]);
    render(<Connections api={api} />);
    const button = await screen.findByRole("button", { name: /^remove$/i });

    apiPost.mockImplementationOnce(() =>
      Promise.reject(new Error("still working; disconnect it instead")),
    );
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByText(/still working/i)).toBeDefined());
    expect(document.body.textContent).toContain("Example Bank");
  });
});
