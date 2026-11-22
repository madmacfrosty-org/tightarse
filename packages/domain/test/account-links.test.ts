import { describe, it, expect, vi, beforeEach } from "vitest";
import { continuedBy, joinAccounts, separateAccounts } from "../src/index.js";

/**
 * Saying by hand that two accounts are one, and taking it back.
 *
 * The automatic match needs two transactions in common. An account renamed
 * while dormant has none, and a match can be wrong however good its evidence —
 * so both directions exist, and most of what follows is about refusing a join
 * that would make the figures unreadable rather than merely wrong.
 */

const listAccounts = vi.fn();
const markSuperseded =
  vi.fn<
    (
      t: string,
      a: string,
      b: string,
      at: string,
      evidence: { shared: number } | { by: string },
    ) => Promise<void>
  >(async () => {});
const clearSuperseded = vi.fn(async () => {});
const deps = { ledger: { listAccounts, markSuperseded, clearSuperseded } };

const NOW = new Date("2026-11-12T10:00:00.000Z");
const row = (accountId: string, over: Record<string, unknown> = {}) => ({
  accountId,
  displayName: accountId,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  markSuperseded.mockResolvedValue(undefined);
  clearSuperseded.mockResolvedValue(undefined);
  listAccounts.mockResolvedValue([row("old"), row("new")]);
});

describe("joining two accounts by hand", () => {
  it("records the link on the account the provider stopped returning", async () => {
    const out = await joinAccounts(deps, "frost", "old", "new", "me@example.invalid", NOW);

    expect(out).toEqual({ supersededId: "old", survivingId: "new" });
    expect(markSuperseded).toHaveBeenCalledWith(
      "frost",
      "old",
      "new",
      NOW.toISOString(),
      { by: "me@example.invalid" },
    );
  });

  it("stores who said so, not a count", async () => {
    // A count would say a machine found evidence. Nobody did; a person decided.
    await joinAccounts(deps, "frost", "old", "new", "me@example.invalid", NOW);

    const evidence = markSuperseded.mock.calls[0]![4];
    expect(evidence).not.toHaveProperty("shared");
    expect(evidence).toEqual({ by: "me@example.invalid" });
  });

  it("refuses an account continuing into itself", async () => {
    await expect(
      joinAccounts(deps, "frost", "old", "old", "me@example.invalid", NOW),
    ).rejects.toThrow(/cannot continue itself/);
    expect(markSuperseded).not.toHaveBeenCalled();
  });

  it("refuses an account it does not hold", async () => {
    await expect(
      joinAccounts(deps, "frost", "ghost", "new", "me@example.invalid", NOW),
    ).rejects.toThrow(/No account ghost/);
  });

  it("refuses when the surviving account is the one that does not exist", async () => {
    await expect(
      joinAccounts(deps, "frost", "old", "ghost", "me@example.invalid", NOW),
    ).rejects.toThrow(/No account ghost/);
  });

  it("refuses to overwrite a link that is already there", async () => {
    // Repointing silently would move a set of transactions from one balance to
    // another with nothing said. Separate first, which is one button.
    listAccounts.mockResolvedValue([
      row("old", { supersededBy: "new" }),
      row("new"),
      row("other"),
    ]);

    await expect(
      joinAccounts(deps, "frost", "old", "other", "me@example.invalid", NOW),
    ).rejects.toThrow(/already continues into new/);
    expect(markSuperseded).not.toHaveBeenCalled();
  });

  it("refuses a join that would make a loop", async () => {
    // Reading an id follows the chain to its end. A loop has no end, and the
    // resolver stops rather than hangs — so the figures would depend on where
    // the walk started, which is not an answer.
    listAccounts.mockResolvedValue([row("a"), row("b", { supersededBy: "a" })]);

    await expect(
      joinAccounts(deps, "frost", "a", "b", "me@example.invalid", NOW),
    ).rejects.toThrow(/continue into each other/);
    expect(markSuperseded).not.toHaveBeenCalled();
  });

  it("allows a chain, which is an account replaced twice", async () => {
    listAccounts.mockResolvedValue([
      row("first", { supersededBy: "second" }),
      row("second"),
      row("third"),
    ]);

    await expect(
      joinAccounts(deps, "frost", "second", "third", "me@example.invalid", NOW),
    ).resolves.toEqual({ supersededId: "second", survivingId: "third" });
  });
});

describe("taking a join back", () => {
  it("clears the link", async () => {
    listAccounts.mockResolvedValue([row("old", { supersededBy: "new" }), row("new")]);

    await expect(separateAccounts(deps, "frost", "old")).resolves.toEqual({
      accountId: "old",
    });
    expect(clearSuperseded).toHaveBeenCalledWith("frost", "old");
  });

  it("succeeds on an account that was not joined to anything", async () => {
    // The state being asked for already holds. A button that errors for having
    // nothing to do teaches people to distrust it.
    await expect(separateAccounts(deps, "frost", "old")).resolves.toEqual({
      accountId: "old",
    });
  });

  it("refuses an account it does not hold", async () => {
    await expect(separateAccounts(deps, "frost", "ghost")).rejects.toThrow(
      /No account ghost/,
    );
    expect(clearSuperseded).not.toHaveBeenCalled();
  });
});

describe("what each surviving account absorbed", () => {
  it("reports the link against the account still in use, not the one that went", async () => {
    // The link is written on the superseded row, which is the right place to
    // write it and the wrong place to read it: the screen lists what the
    // household has.
    const by = continuedBy([
      row("old", { supersededBy: "new", reconciledAt: "2026-11-03T07:00:00.000Z", reconciledShared: 86 }),
      row("new"),
    ]);

    expect([...by.keys()]).toEqual(["new"]);
    expect(by.get("new")).toEqual([
      {
        accountId: "old",
        displayName: "old",
        since: "2026-11-03T07:00:00.000Z",
        sharedTransactions: 86,
      },
    ]);
  });

  it("says a person joined them, where a person did", async () => {
    const by = continuedBy([
      row("old", { supersededBy: "new", reconciledBy: "me@example.invalid" }),
      row("new"),
    ]);

    expect(by.get("new")?.[0]).toMatchObject({ joinedBy: "me@example.invalid" });
    expect(by.get("new")?.[0]).not.toHaveProperty("sharedTransactions");
  });

  it("attributes a double replacement to the card in the wallet now", async () => {
    // `first` superseded into `second`, which superseded into `third`. Only
    // `third` is on screen, so both belong to it or they belong nowhere.
    const by = continuedBy([
      row("first", { supersededBy: "second" }),
      row("second", { supersededBy: "third" }),
      row("third"),
    ]);

    expect(by.get("third")?.map((c) => c.accountId).sort()).toEqual(["first", "second"]);
  });

  it("says nothing for a household where nothing was joined", async () => {
    expect(continuedBy([row("a"), row("b")]).size).toBe(0);
  });

  it("ignores a link pointing at an account that is itself superseded and gone", async () => {
    // Nothing on screen to attach it to. Dropping it beats inventing a row.
    const by = continuedBy([row("old", { supersededBy: "missing" })]);

    expect(by.size).toBe(0);
  });
});
