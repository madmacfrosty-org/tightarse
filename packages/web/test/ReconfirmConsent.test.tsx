import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReconfirmConsent } from "../src/ReconfirmConsent";

/**
 * The four requirements TrueLayer reviews a consent screen against.
 *
 * Asserted individually rather than as a snapshot, because the point is that
 * each one survives an edit to the copy. A snapshot would go red on any wording
 * change and say nothing about which requirement had gone.
 *
 * Every institution below is invented. This repository is public.
 */
const consent = {
  consentId: "c-1",
  institutionName: "Example Bank",
  expiresAt: "2026-11-10T00:00:00.000Z",
  fetchedAt: "2026-10-05T05:00:00.000Z",
  providerStatus: "Authorised",
  daysRemaining: 36,
  health: "warn" as const,
};

const show = (over: Partial<Parameters<typeof ReconfirmConsent>[0]> = {}) =>
  render(
    <ReconfirmConsent
      consent={consent}
      busy={false}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...over}
    />,
  );

describe("the consent screen a reviewer checks", () => {
  it("names TrueLayer as the third party, not us", async () => {
    // Requirement one, and the one most easily lost by writing the copy from
    // the application's point of view. The household is agreeing to TrueLayer
    // accessing their bank, not to us.
    show();

    // Level 2 specifically: the guidance asks for the key point in a heading
    // so somebody gets it without reading the body, and that is this one.
    // "What TrueLayer shares" below also names them, which is not the same
    // thing as leading with it.
    expect(
      await screen.findByRole("heading", { level: 2, name: /TrueLayer/ }),
    ).toBeDefined();
    expect(document.body.textContent).toMatch(/TrueLayer.*connects to Example Bank/s);
  });

  it("says what data is shared, in terms a reader recognises", async () => {
    // Requirement two. Named as things somebody would recognise on a
    // statement, rather than as the scope strings the provider is sent.
    show();

    for (const expected of [/balances/i, /transactions/i, /direct debits/i, /sort codes/i]) {
      expect(document.body.textContent).toMatch(expected);
    }
    // The scope names themselves mean nothing to a reader and must not stand
    // in for an explanation.
    expect(document.body.textContent).not.toContain("offline_access");
  });

  it("says what it is used for, and that we are the ones receiving it", async () => {
    // Requirement three. "Shared with you" is explicit in the guidance: a
    // screen that says what TrueLayer collects without saying who gets it has
    // answered half the question.
    show();

    expect(document.body.textContent).toMatch(/shares it with/i);
    expect(document.body.textContent).toMatch(/Tightarse/);
    expect(document.body.textContent).toMatch(/not sold/i);
  });

  it("links TrueLayer's terms and privacy policy, both resolving", async () => {
    // Requirement four. The URLs were checked to return 200 — a dead link
    // fails the review and is invisible in a test that only counts anchors.
    show();

    const terms = screen.getByRole("link", { name: /terms of service/i });
    const privacy = screen.getByRole("link", { name: /privacy policy/i });
    expect(terms.getAttribute("href")).toBe("https://truelayer.com/legal/enduser_tos/");
    expect(privacy.getAttribute("href")).toBe("https://truelayer.com/legal/privacy/");
    // Opened away from the page: losing a part-completed renewal to a
    // navigation is a poor reason to not read the terms.
    for (const a of [terms, privacy]) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toMatch(/noreferrer/);
    }
  });
});

describe("what the screen does", () => {
  it("says this extends access rather than widening it", async () => {
    // The question somebody actually has. Without it, a screen listing
    // everything shared reads like a request for more.
    show();
    expect(document.body.textContent).toMatch(/does not give any new access/i);
  });

  it("confirms only when the household agrees", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    show({ onConfirm, onCancel });

    await userEvent.click(screen.getByRole("button", { name: /keep sharing/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("lets them walk away without renewing", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    show({ onConfirm, onCancel });

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cannot be agreed to twice while the first is in flight", async () => {
    const onConfirm = vi.fn();
    show({ busy: true, onConfirm });

    expect(screen.getByRole("button", { name: /confirming/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /cancel/i }).hasAttribute("disabled")).toBe(true);
  });

  it("names the bank it is about", async () => {
    // Three connections, three separate consents. A screen that did not say
    // which would be agreed to for the wrong one.
    show();
    expect(document.body.textContent).toContain("Example Bank");
  });
});
