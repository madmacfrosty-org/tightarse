import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiGet = vi.fn();
// Supplied as an object, not a replaced module.
const api = { get: <T,>(p: string) => apiGet(p) as Promise<T> };

const assign = vi.fn();

beforeEach(() => {
  apiGet.mockReset();
  assign.mockReset();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign, search: "", pathname: "/" },
  });
});

describe("ConnectBank", () => {
  it("offers the banks the API will accept", async () => {
    // The provider list is an allow-list on the server too; a button here for
    // something the API refuses is a dead end.
    const { ConnectBank } = await import("../src/Connect");
    render(<ConnectBank api={api} />);
    for (const label of ["First Direct", "American Express", "Another bank…"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  it("sends the browser to the consent URL the API returns", async () => {
    apiGet.mockResolvedValue({ url: "https://auth.truelayer.com/?providers=ob-amex" });
    const { ConnectBank } = await import("../src/Connect");
    render(<ConnectBank api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "American Express" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://auth.truelayer.com/?providers=ob-amex"));
    expect(apiGet).toHaveBeenCalledWith(`${pathFor("/connect/start")}?provider=ob-amex`);
  });

  it("disables every provider while one is redirecting", async () => {
    // Two consents started at once would burn the deep-history window on the
    // one the user abandons.
    apiGet.mockReturnValue(new Promise(() => {}));
    const { ConnectBank } = await import("../src/Connect");
    render(<ConnectBank api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "First Direct" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "American Express" })).toHaveProperty("disabled", true),
    );
  });

  it("reports a failure to start instead of silently doing nothing", async () => {
    apiGet.mockRejectedValue(new Error("No household on this identity"));
    const { ConnectBank } = await import("../src/Connect");
    render(<ConnectBank api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "First Direct" }));
    expect(await screen.findByText("No household on this identity")).toBeDefined();
  });
});

describe("Connected", () => {
  const withSearch = (search: string) => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, search, pathname: "/connected" },
    });
  };

  it("exchanges the code and reports when access expires", async () => {
    withSearch("?code=abc123");
    apiGet.mockResolvedValue({ connectionId: "conn-1", consentExpiresAt: "2026-11-10T00:00:00.000Z" });
    const { Connected } = await import("../src/Connect");
    render(<Connected api={api} onFinished={() => {}} />);

    expect(await screen.findByText("Connected")).toBeDefined();
    expect(screen.getByText("2026-11-10")).toBeDefined();
    expect(apiGet).toHaveBeenCalledWith(`${pathFor("/connect/callback")}?code=abc123`);
  });

  it("explains a reload rather than reporting a bank failure", async () => {
    // A spent code resent on reload used to present as a provider rejection,
    // which sends you back to the bank for no reason.
    withSearch("");
    const { Connected } = await import("../src/Connect");
    render(<Connected api={api} onFinished={() => {}} />);
    expect(await screen.findByText(/code was already used/)).toBeDefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("surfaces the provider's own error text when it refuses", async () => {
    withSearch("?error=access_denied&error_description=You+cancelled+at+the+bank");
    const { Connected } = await import("../src/Connect");
    render(<Connected api={api} onFinished={() => {}} />);
    expect(await screen.findByText("You cancelled at the bank")).toBeDefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("reports an exchange failure with the reason", async () => {
    withSearch("?code=abc123");
    apiGet.mockRejectedValue(new Error("Provider rejected the code (400)"));
    const { Connected } = await import("../src/Connect");
    render(<Connected api={api} onFinished={() => {}} />);
    expect(await screen.findByText("Provider rejected the code (400)")).toBeDefined();
  });

  it("offers a way back to the dashboard from either outcome", async () => {
    withSearch("?code=abc123");
    apiGet.mockResolvedValue({ connectionId: "c", consentExpiresAt: "2026-11-10T00:00:00.000Z" });
    const onFinished = vi.fn();
    const { Connected } = await import("../src/Connect");
    render(<Connected api={api} onFinished={onFinished} />);
    await userEvent.click(await screen.findByRole("button", { name: /back to the dashboard/i }));
    expect(onFinished).toHaveBeenCalled();
  });
});
