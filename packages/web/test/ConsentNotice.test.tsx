import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsentNotice } from "../src/ConsentNotice";
import type { ConsentView } from "@tightarse/api-contract";

/**
 * The one thing on the dashboard with a deadline.
 *
 * When a consent lapses the feed stops and every figure on the page goes on
 * looking exactly as healthy as the day before. The properties worth protecting
 * are that silence means "nothing known" rather than "all well", and that a
 * frozen row is as loud as an expired one.
 *
 * Every name and date here is invented.
 */

const consent = (over: Partial<ConsentView> = {}): ConsentView => ({
  consentId: "c1",
  institutionName: "Some Bank",
  expiresAt: "2026-11-09T00:00:00Z",
  providerStatus: "Authorised",
  daysRemaining: 56,
  health: "ok",
  ...over,
});

describe("the consent notice", () => {
  it("says nothing at all when every connection is fine", () => {
    const { container } = render(<ConsentNotice consents={[consent()]} />);
    expect(container.textContent).toBe("");
  });

  it("says nothing before a sync has written one, rather than announcing good news", () => {
    // Empty means not known yet. A screen that said "all well" here would be
    // inventing it — nothing has asked the provider.
    const { container } = render(<ConsentNotice consents={[]} />);
    expect(container.textContent).toBe("");
  });

  it("names the bank and counts the days down", () => {
    render(<ConsentNotice consents={[consent({ health: "warn", daysRemaining: 28 })]} />);
    expect(screen.getByText(/Some Bank expires in 28 days/)).toBeDefined();
  });

  it("reads as one day rather than 1 days", () => {
    render(<ConsentNotice consents={[consent({ health: "escalate", daysRemaining: 1 })]} />);
    expect(screen.getByText(/expires in 1 day\./)).toBeDefined();
  });

  it("treats a frozen row as loudly as an expired one", () => {
    // The case that is easy to miss: this row still claims two months left. A
    // lapsed consent stops producing rows, so nothing refreshing it is the
    // signal, not the date it last carried.
    render(
      <ConsentNotice consents={[consent({ health: "stale", daysRemaining: 56 })]} />,
    );
    expect(screen.getByText(/has not reported in/)).toBeDefined();
    expect(document.querySelector(".consent-notice.expired")).toBeTruthy();
  });

  it("says the feed has already stopped when it has", () => {
    render(<ConsentNotice consents={[consent({ health: "expired", daysRemaining: -3 })]} />);
    expect(screen.getByText(/has expired/)).toBeDefined();
  });

  it("shows the provider's own word without acting on it", () => {
    render(
      <ConsentNotice
        consents={[consent({ health: "warn", providerStatus: "SomethingNew" })]}
      />,
    );
    expect(screen.getByText(/SomethingNew/)).toBeDefined();
  });

  it("takes its tone from the worst connection, not the first", () => {
    render(
      <ConsentNotice
        consents={[
          consent({ consentId: "a", health: "warn", daysRemaining: 28 }),
          consent({ consentId: "b", health: "expired", daysRemaining: -1 }),
        ]}
      />,
    );
    expect(document.querySelector(".consent-notice.expired")).toBeTruthy();
  });

  it("leaves the healthy ones off the list entirely", () => {
    render(
      <ConsentNotice
        consents={[
          consent({ consentId: "a", institutionName: "Fine Bank" }),
          consent({ consentId: "b", institutionName: "Bad Bank", health: "warn" }),
        ]}
      />,
    );
    expect(screen.queryByText(/Fine Bank/)).toBeNull();
    expect(screen.getByText(/Bad Bank/)).toBeDefined();
  });

  it("falls back to a plain phrase when the bank has no name", () => {
    render(
      <ConsentNotice
        consents={[consent({ institutionName: undefined, health: "warn", daysRemaining: 5 })]}
      />,
    );
    expect(screen.getByText(/A bank connection expires in 5 days/)).toBeDefined();
  });
});
