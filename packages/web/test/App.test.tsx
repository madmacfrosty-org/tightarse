import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiGet, renderAt, reset, requested, session } from "./harness";

/**
 * The routing, which is all this file now covers.
 *
 * What each page shows is that page's own test. What is here is the split
 * itself: that an address reaches the page it names, that the pages can reach
 * each other, that an address which is not a page says so — and above all that
 * `/connected` still works, because that is the one route where a mistake costs
 * years of bank history that no amount of retrying gets back.
 */

beforeEach(reset);

describe("returning from a bank authorisation", () => {
  /*
   * Roughly an hour after an authorisation, only ninety days of history remain
   * available, for ever. A routing change that drops this callback is not a bug
   * that gets fixed on the next deploy — the history is gone. So it is tested
   * from the address inwards, through the router that ships.
   */

  it("exchanges the code the provider returned", async () => {
    await renderAt("/connected?code=provider-code");
    expect(await screen.findByText("Connected")).toBeDefined();
    expect(requested()).toContain("/v1/connect/callback?code=provider-code");
  });

  it("is not swallowed by the page that catches unknown addresses", async () => {
    // Declared before the catch-all and outside the layout. If the order ever
    // changes, a completed authorisation lands on "that page does not exist"
    // with a single-use code in the address bar.
    await renderAt("/connected?code=provider-code");
    await screen.findByText("Connected");
    expect(screen.queryByText("That page does not exist")).toBeNull();
  });

  it("does not render the glance over the top of it", async () => {
    // The failure mode this replaces was a path comparison: the callback used
    // to be an `if` inside the dashboard, and anything that reordered those
    // branches rendered the household's figures instead of exchanging the code.
    await renderAt("/connected?code=provider-code");
    await screen.findByText("Connected");
    expect(screen.queryByText("Net position")).toBeNull();
    expect(requested().filter((p) => p.includes("/books"))).toEqual([]);
  });

  it("reports a provider error rather than exchanging nothing", async () => {
    await renderAt("/connected?error=access_denied&error_description=Consent+refused");
    expect(await screen.findByText("Consent refused")).toBeDefined();
    expect(requested()).toEqual([]);
  });
});

describe("the pages", () => {
  it("lands on the glance at the root", async () => {
    await renderAt("/");
    expect(await screen.findByText("Net position")).toBeDefined();
  });

  it("shows spending, and nothing about the position, at /spending", async () => {
    await renderAt("/spending");
    expect(await screen.findByText("Where it goes")).toBeDefined();
    expect(screen.queryByText("Net position")).toBeNull();
  });

  it("shows the categorisation screen, and no figures, at /categories", async () => {
    await renderAt("/categories");
    expect(await screen.findByLabelText("Merchant")).toBeDefined();
    expect(screen.queryByText("Net position")).toBeNull();
    expect(screen.queryByText("Where it goes")).toBeNull();
  });

  it("shows the operator's tools, and no spending, at /operations", async () => {
    await renderAt("/operations");
    expect(await screen.findByText("Connect a bank")).toBeDefined();
    expect(screen.getByRole("button", { name: "Run the check" })).toBeDefined();
    expect(screen.queryByText("Where it goes")).toBeNull();
    expect(screen.queryByText("Net position")).toBeNull();
  });

  it("asks for nothing at all on the page nobody opens weekly", async () => {
    // The dev account's Lambda concurrency limit is five and the single page
    // made five calls on load. The reconciliation is asked for by a button and
    // a connection is a decision, so arriving here costs none of it.
    await renderAt("/operations");
    await screen.findByText("Connect a bank");
    expect(requested()).toEqual([]);
  });
});

describe("moving between the pages", () => {
  it("names every destination and marks the one you are on", async () => {
    await renderAt("/");
    await screen.findByText("Net position");
    for (const label of ["Home", "Spending", "Categories", "Operations"]) {
      expect(screen.getByRole("link", { name: label })).toBeDefined();
    }
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Spending" }).getAttribute("aria-current")).toBeNull();
  });

  it("gets from one to another without a typed address", async () => {
    await renderAt("/");
    await screen.findByText("Net position");
    await userEvent.click(screen.getByRole("link", { name: "Spending" }));
    expect(await screen.findByText("Where it goes")).toBeDefined();
    expect(window.location.pathname).toBe("/spending");
    expect(screen.getByRole("link", { name: "Spending" }).getAttribute("aria-current")).toBe("page");
    // Every other path starts with "/", so without `end` on that link the home
    // tab is marked current on all four pages.
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("keeps the operator's page reachable without giving it a tab", async () => {
    // Urgent comes to you, routine you go to. It has to be one click from
    // anywhere and must not sit beside the three a household uses weekly.
    await renderAt("/");
    await screen.findByText("Net position");
    const nav = document.querySelector("nav.nav")!;
    expect(nav.textContent).toBe("HomeSpendingCategories");
    await userEvent.click(screen.getByRole("link", { name: "Operations" }));
    expect(await screen.findByText("Connect a bank")).toBeDefined();
  });
});

describe("an address that is not a page", () => {
  it("says so rather than showing a blank screen", async () => {
    // CloudFront serves index.html for 403 and 404 alike, so a mistyped path
    // arrives here rather than at the bucket's error page.
    await renderAt("/speding");
    expect(await screen.findByText("That page does not exist")).toBeDefined();
  });

  it("does not quietly render the glance as though the address were right", async () => {
    await renderAt("/speding");
    await screen.findByText("That page does not exist");
    expect(screen.queryByText("Net position")).toBeNull();
    expect(requested()).toEqual([]);
  });

  it("offers the way back", async () => {
    await renderAt("/speding");
    await userEvent.click(await screen.findByRole("link", { name: /Back to where we stand/ }));
    expect(await screen.findByText("Net position")).toBeDefined();
  });
});

describe("when nobody is signed in", () => {
  it("offers sign-in rather than an empty dashboard", async () => {
    // Nobody signed in: the port says so directly, rather than a module being
    // reached into and re-mocked mid-test.
    session.current.mockResolvedValueOnce(null);
    await renderAt("/");
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined());
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("gates the bank callback too, rather than exchanging a code for nobody", async () => {
    session.current.mockResolvedValueOnce(null);
    await renderAt("/connected?code=provider-code");
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined());
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("says what went wrong when the session itself failed", async () => {
    session.current.mockRejectedValueOnce(new Error("This account has no household assigned."));
    await renderAt("/");
    expect(await screen.findByText("This account has no household assigned.")).toBeDefined();
  });
});

describe("chrome", () => {
  it("says who is signed in, on every page", async () => {
    await renderAt("/spending");
    expect(await screen.findByText(/someone@example.com/)).toBeDefined();
  });

  it("signs out through the port", async () => {
    await renderAt("/");
    await screen.findByText("Net position");
    await userEvent.click(screen.getByRole("button", { name: "sign out" }));
    expect(session.signOut).toHaveBeenCalled();
  });
});
