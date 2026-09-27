import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  providerStatus: "Authorised",
  daysRemaining: 40,
  health: "ok",
  ...over,
});

const apiGet = vi.fn(async (_p: string): Promise<unknown> => ({ accounts: [], consents: [] }));
const api = {
  get: <T,>(schema: Parses<T>, p: string) =>
    apiGet(p).then((body: unknown) => schema.parse(body)),
  post: <T,>(schema: Parses<T>, _p: string, b: unknown) =>
    Promise.resolve(schema.parse(b)),
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
});
