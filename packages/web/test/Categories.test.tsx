import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiGet, defaultApiGet, renderAt, requested, reset } from "./harness";

/**
 * The bookkeeper's page at `/categories`.
 *
 * `Categorise` itself has its own tests; what is here is the one thing this
 * page adds, which is the window the search runs over. A rule made from a
 * search reaches the whole ledger, so offering a year when the household has
 * five would hide the transactions most worth a rule.
 */

beforeEach(reset);

const search = async (term: string) => {
  await userEvent.type(await screen.findByLabelText("Merchant"), term);
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
};

describe("the window the search runs over", () => {
  it("is everything every account covers, not an arbitrary year", async () => {
    await renderAt("/categories");
    await search("SOMEMART");
    await waitFor(() => {
      const found = requested().find((p) => p.startsWith(pathFor("/transactions")));
      // completeFrom from the accounts response.
      expect(found).toContain("from=2024-01-01");
    });
  });

  it("falls back to a year rather than failing when that is not known", async () => {
    // A narrower search is a worse answer; a broken screen is no answer. The
    // search reports its own failures, so this one stays quiet.
    apiGet.mockImplementation(async (path: string) =>
      path.startsWith(pathFor("/accounts")) ? Promise.reject(new Error("no")) : defaultApiGet(path),
    );
    await renderAt("/categories");
    await search("SOMEMART");
    await waitFor(() => {
      const found = requested().find((p) => p.startsWith(pathFor("/transactions")));
      const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      expect(found).toContain(`from=${yearAgo}`);
    });
    expect(screen.getByLabelText("Merchant")).toBeDefined();
  });
});
