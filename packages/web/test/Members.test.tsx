import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pathFor } from "@tightarse/api-contract";
import type { Parses } from "../src/ports";
import { Members } from "../src/Members";

/**
 * Who can see the household.
 *
 * Every address below is invented. This repository is public.
 */
const apiGet = vi.fn(async (_p: string): Promise<unknown> => ({ members: [] }));
const apiPost = vi.fn(async (_p: string, _b: unknown): Promise<unknown> => ({
  email: "them@example.invalid",
  role: "member",
}));
const api = {
  get: <T,>(schema: Parses<T>, p: string) => apiGet(p).then((b: unknown) => schema.parse(b)),
  post: <T,>(schema: Parses<T>, p: string, b: unknown) =>
    apiPost(p, b).then((r: unknown) => schema.parse(r)),
};

const withMembers = (members: unknown[]) => {
  apiGet.mockImplementation(async (p: string) => {
    if (p.startsWith(pathFor("/members"))) return { members };
    throw new Error(`unexpected path ${p}`);
  });
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue({ email: "them@example.invalid", role: "member" });
});

describe("the list of who has access", () => {
  it("says plainly what access means", async () => {
    // A row here is the whole authorisation model — no second factor, no
    // per-page permission. Somebody adding an address should know that
    // before they press the button, not after.
    withMembers([{ email: "owner@example.invalid", role: "admin" }]);
    render(<Members api={api} />);

    expect(await screen.findByText(/every account, balance and transaction/i)).toBeDefined();
  });

  it("names everyone and what they can do", async () => {
    withMembers([
      { email: "owner@example.invalid", role: "admin" },
      { email: "them@example.invalid", role: "member" },
    ]);
    render(<Members api={api} />);

    expect(await screen.findByText("owner@example.invalid")).toBeDefined();
    // Scoped to the table: the role names also appear in the dropdown below,
    // which is a different question being asked of the same words.
    const rows = [...document.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
    expect(rows.find((t) => t.includes("owner@example.invalid"))).toMatch(/Administrator/);
    expect(rows.find((t) => t.includes("them@example.invalid"))).toMatch(/Member/);
  });

  it("puts administrators first, because that is the question being asked", async () => {
    withMembers([
      { email: "zoe@example.invalid", role: "member" },
      { email: "alice@example.invalid", role: "member" },
      { email: "owner@example.invalid", role: "admin" },
    ]);
    render(<Members api={api} />);
    await screen.findByText("owner@example.invalid");

    const order = [...document.querySelectorAll("tbody tr")].map(
      (r) => r.querySelector("td")!.textContent,
    );
    expect(order).toEqual([
      "owner@example.invalid",
      "alice@example.invalid",
      "zoe@example.invalid",
    ]);
  });

  it("reports a refusal rather than an empty list", async () => {
    // "You may not see this" and "nobody has access" are very different
    // things and must not look alike.
    apiGet.mockRejectedValue(new Error("Only an administrator of this household can"));
    render(<Members api={api} />);

    await waitFor(() =>
      expect(screen.getByText(/Only an administrator/i)).toBeDefined(),
    );
  });
});

describe("giving somebody access", () => {
  it("sends the address and the role", async () => {
    withMembers([{ email: "owner@example.invalid", role: "admin" }]);
    render(<Members api={api} />);
    await screen.findByText("owner@example.invalid");

    await userEvent.type(screen.getByLabelText("Email address"), "them@example.invalid");
    await userEvent.selectOptions(screen.getByLabelText("What they can do"), "member");
    await userEvent.click(screen.getByRole("button", { name: /give access/i }));

    await waitFor(() =>
      expect(apiPost.mock.calls.at(-1)?.[1]).toEqual({
        email: "them@example.invalid",
        role: "member",
      }),
    );
  });

  it("says what the chosen role can do, before it is used", async () => {
    withMembers([{ email: "owner@example.invalid", role: "admin" }]);
    render(<Members api={api} />);
    await screen.findByText("owner@example.invalid");

    await userEvent.selectOptions(screen.getByLabelText("What they can do"), "admin");

    expect(screen.getByText(/change who has access/i)).toBeDefined();
  });

  it("catches a malformed address without a round trip", async () => {
    withMembers([{ email: "owner@example.invalid", role: "admin" }]);
    render(<Members api={api} />);
    await screen.findByText("owner@example.invalid");

    await userEvent.type(screen.getByLabelText("Email address"), "not-an-address");
    const before = apiPost.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /give access/i }));

    expect(await screen.findByText(/does not look like an email/i)).toBeDefined();
    expect(apiPost.mock.calls.length).toBe(before);
  });

  it("reports a refusal and keeps the list on screen", async () => {
    withMembers([{ email: "owner@example.invalid", role: "admin" }]);
    render(<Members api={api} />);
    await screen.findByText("owner@example.invalid");

    apiPost.mockRejectedValueOnce(new Error("already has access to a different household"));
    await userEvent.type(screen.getByLabelText("Email address"), "them@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: /give access/i }));

    await waitFor(() =>
      expect(screen.getByText(/different household/i)).toBeDefined(),
    );
    expect(screen.getByText("owner@example.invalid")).toBeDefined();
  });
});

describe("taking access away", () => {
  it("asks first, and says what happens", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    withMembers([
      { email: "owner@example.invalid", role: "admin" },
      { email: "them@example.invalid", role: "member" },
    ]);
    render(<Members api={api} />);
    await screen.findByText("them@example.invalid");

    const before = apiPost.mock.calls.length;
    await userEvent.click(screen.getAllByRole("button", { name: /^remove$/i })[1]!);

    expect(ask.mock.calls[0]![0] as string).toMatch(/lose access/i);
    expect(apiPost.mock.calls.length).toBe(before);
    ask.mockRestore();
  });

  it("removes them when agreed", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    withMembers([
      { email: "owner@example.invalid", role: "admin" },
      { email: "them@example.invalid", role: "member" },
    ]);
    render(<Members api={api} />);
    await screen.findByText("them@example.invalid");

    await userEvent.click(screen.getAllByRole("button", { name: /^remove$/i })[1]!);

    await waitFor(() =>
      expect(apiPost.mock.calls.at(-1)?.[1]).toEqual({ email: "them@example.invalid" }),
    );
    ask.mockRestore();
  });
});
