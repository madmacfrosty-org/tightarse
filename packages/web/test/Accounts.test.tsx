import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Parses } from "../src/ports";
import { Accounts } from "../src/Accounts";

/**
 * Which accounts are really one account.
 *
 * Every name and address below is invented. This repository is public.
 *
 * The thing worth protecting is that a join is never silent. It files one
 * account's transactions under another and the total reads plausibly either
 * way, so a screen that showed the result without saying it had happened would
 * be the same failure in a new place.
 */

const apiGet = vi.fn(async (_p: string): Promise<unknown> => ({ accounts: [], consents: [] }));
// Answers per route. The two responses have different shapes, and a single
// stub returning one of them makes the other parse fail — which reads as a
// component bug rather than a fixture one.
const apiPost = vi.fn(async (p: string, _b: unknown): Promise<unknown> =>
  p.includes("/accounts/separate")
    ? { accountId: "old" }
    : { supersededId: "old", survivingId: "new" },
);

const api = {
  get: <T,>(schema: Parses<T>, p: string) => apiGet(p).then((b: unknown) => schema.parse(b)),
  post: <T,>(schema: Parses<T>, p: string, b: unknown) =>
    apiPost(p, b).then((r: unknown) => schema.parse(r)),
};

const account = (accountId: string, over: Record<string, unknown> = {}) => ({
  accountId,
  displayName: accountId,
  institutionName: "A BANK",
  isCard: true,
  ...over,
});

const withAccounts = (accounts: unknown[]) => {
  apiGet.mockImplementation(async () => ({ accounts, consents: [] }));
};

beforeEach(() => {
  vi.clearAllMocks();
  apiPost.mockImplementation(async (p: string) =>
    p.includes("/accounts/separate")
      ? { accountId: "old" }
      : { supersededId: "old", survivingId: "new" },
  );
  withAccounts([account("new")]);
});

describe("saying what was joined", () => {
  it("says nothing extra about an account that continues nothing", async () => {
    render(<Accounts api={api} />);
    await screen.findByText("new");

    expect(screen.queryByText(/Continues/)).toBeNull();
  });

  it("names what a card replaced, and when", async () => {
    withAccounts([
      account("new", {
        continues: [
          { accountId: "old", displayName: "The old card", since: "2026-11-03T07:00:00.000Z", sharedTransactions: 86 },
        ],
      }),
    ]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/The old card/)).toBeDefined();
    expect(screen.getByText(/since 2026-11-03/)).toBeDefined();
  });

  it("says how it was worked out, so the match can be judged", async () => {
    // 86 is a card reissued. Two is the threshold and worth a second look, and
    // the difference is only visible if the number is shown.
    withAccounts([
      account("new", { continues: [{ accountId: "old", sharedTransactions: 86 }] }),
    ]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/86 transactions they both hold/)).toBeDefined();
  });

  it("says when a person joined them rather than implying evidence was found", async () => {
    withAccounts([
      account("new", { continues: [{ accountId: "old", joinedBy: "someone@example.invalid" }] }),
    ]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/Joined by someone@example.invalid/)).toBeDefined();
    expect(screen.queryByText(/they both hold/)).toBeNull();
  });

  it("lists both when a card was replaced twice", async () => {
    withAccounts([
      account("third", {
        continues: [
          { accountId: "first", displayName: "First card" },
          { accountId: "second", displayName: "Second card" },
        ],
      }),
    ]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/First card/)).toBeDefined();
    expect(screen.getByText(/Second card/)).toBeDefined();
  });
});

describe("naming an account", () => {
  it("falls back to the bank when the account has no name of its own", async () => {
    withAccounts([account("abcdef1234", { displayName: undefined })]);
    render(<Accounts api={api} />);

    expect(await screen.findByText("A BANK")).toBeDefined();
  });

  it("falls back to a short id when it has neither", async () => {
    withAccounts([
      account("abcdef1234", { displayName: undefined, institutionName: undefined }),
    ]);
    render(<Accounts api={api} />);

    expect(await screen.findByText("abcdef12")).toBeDefined();
  });

  it("counts one shared transaction as one, not one transactions", async () => {
    withAccounts([
      account("new", { continues: [{ accountId: "old", sharedTransactions: 1 }] }),
    ]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/1 transaction they both hold/)).toBeDefined();
  });

  it("says a join happened even when nothing recorded how", async () => {
    // Rows written before the evidence was stored. Saying "joined" and no more
    // beats saying nothing, because the join is the part that must be visible.
    withAccounts([account("new", { continues: [{ accountId: "old" }] })]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/Joined\./)).toBeDefined();
  });
});

describe("undoing a join", () => {
  beforeEach(() => {
    withAccounts([
      account("new", { continues: [{ accountId: "old", sharedTransactions: 86 }] }),
    ]);
  });

  it("separates the account the link was recorded on", async () => {
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Separate" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![0]).toContain("/accounts/separate");
    expect(apiPost.mock.calls[0]![1]).toEqual({ accountId: "old" });
  });

  it("re-reads afterwards rather than patching the screen", async () => {
    // A join decides which transactions count towards which balance. Every
    // figure here is downstream of it.
    render(<Accounts api={api} />);
    await screen.findByRole("button", { name: "Separate" });
    const before = apiGet.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Separate" }));

    await waitFor(() => expect(apiGet.mock.calls.length).toBeGreaterThan(before));
  });

  it("reports a refusal instead of appearing to have worked", async () => {
    apiPost.mockRejectedValueOnce(new Error("No account old in this household."));
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Separate" }));

    expect(await screen.findByText("No account old in this household.")).toBeDefined();
  });
});

describe("joining two by hand", () => {
  beforeEach(() => withAccounts([account("old"), account("new")]));

  it("explains why it exists, since it should almost never be needed", async () => {
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));

    expect(screen.getByText(/renamed while nothing was going in or out/)).toBeDefined();
  });

  it("will not join until both have been chosen", async () => {
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));

    expect(screen.getByRole("button", { name: "Join" })).toHaveProperty("disabled", true);
  });

  it("will not join an account to itself", async () => {
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));
    await userEvent.selectOptions(screen.getByLabelText("The account that stopped"), "old");
    await userEvent.selectOptions(screen.getByLabelText("The account it continues into"), "old");

    expect(screen.getByRole("button", { name: "Join" })).toHaveProperty("disabled", true);
  });

  it("sends which continues into which", async () => {
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));
    await userEvent.selectOptions(screen.getByLabelText("The account that stopped"), "old");
    await userEvent.selectOptions(screen.getByLabelText("The account it continues into"), "new");
    await userEvent.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![0]).toContain("/accounts/join");
    expect(apiPost.mock.calls[0]![1]).toEqual({ supersededId: "old", survivingId: "new" });
  });

  it("does not send who did it — the server takes that from the token", async () => {
    // A client-supplied name on a record of who decided something is a record
    // of what the client claimed.
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));
    await userEvent.selectOptions(screen.getByLabelText("The account that stopped"), "old");
    await userEvent.selectOptions(screen.getByLabelText("The account it continues into"), "new");
    await userEvent.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![1]).not.toHaveProperty("by");
  });

  it("shows a refusal from the server verbatim", async () => {
    apiPost.mockRejectedValueOnce(
      new Error("That would make two accounts continue into each other."),
    );
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));
    await userEvent.selectOptions(screen.getByLabelText("The account that stopped"), "old");
    await userEvent.selectOptions(screen.getByLabelText("The account it continues into"), "new");
    await userEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(
      await screen.findByText(/would make two accounts continue into each other/),
    ).toBeDefined();
  });

  it("puts the form away on cancel without writing anything", async () => {
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /Join two accounts by hand/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("The account that stopped")).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("when it cannot read", () => {
  it("says so rather than showing an empty list", async () => {
    apiGet.mockRejectedValue(new Error("the API said no"));
    render(<Accounts api={api} />);

    expect(await screen.findByText("the API said no")).toBeDefined();
  });

  it("still says something when what was thrown is not an Error", async () => {
    apiGet.mockRejectedValue("a bare string");
    render(<Accounts api={api} />);

    expect(await screen.findByText(/Could not read the accounts/)).toBeDefined();
  });

  it("still says something when an action throws a non-Error", async () => {
    withAccounts([
      account("new", { continues: [{ accountId: "old", sharedTransactions: 86 }] }),
    ]);
    apiPost.mockRejectedValueOnce("a bare string");
    render(<Accounts api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Separate" }));

    expect(await screen.findByText(/That did not work/)).toBeDefined();
  });

  it("says there are none rather than offering to join nothing", async () => {
    withAccounts([]);
    render(<Accounts api={api} />);

    expect(await screen.findByText(/No accounts yet/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Join two accounts/ })).toBeNull();
  });
});
