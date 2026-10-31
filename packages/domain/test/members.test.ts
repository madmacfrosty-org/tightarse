import { describe, it, expect, vi } from "vitest";
import {
  listHouseholdMembers,
  addMember,
  removeMember,
  NotAnAdministrator,
  MemberNotFound,
  AlreadySomebodyElses,
  CannotRemoveYourself,
} from "../src/household/members.js";
import type { Member } from "../src/household/member.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Who can see the household.
 *
 * A row here is the whole authorisation model: whoever holds that address at
 * the identity provider sees every transaction, balance and bank. There is
 * no second factor behind it, so the guard is the thing being tested.
 *
 * Every address and household below is invented. This repository is public.
 */
const NOW = new Date("2026-10-31T12:00:00.000Z");

const member = (over: Partial<Member> = {}): Member => ({
  email: "owner@example.invalid",
  tenantId: "t1",
  addedAt: "2026-08-01T00:00:00.000Z",
  role: "admin",
  ...over,
});

const admin = { email: "owner@example.invalid", tenantId: "t1" };

const deps = (rows: unknown[], otherHousehold: string | null = null) => {
  const put: Member[] = [];
  const deleted: string[] = [];
  return {
    put,
    deleted,
    getMemberTenant: vi.fn(async () => otherHousehold),
    listMembers: vi.fn(async (_t?: string): Promise<Row[]> => rows as Row[]),
    putMember: async (m: Member) => void put.push(m),
    deleteMember: async (e: string) => void deleted.push(e),
  };
};

describe("who may change who has access", () => {
  it("lets an administrator of this household see the list", async () => {
    const d = deps([member(), member({ email: "other@example.invalid", role: "member" })]);

    const out = await listHouseholdMembers(d, admin);

    expect(out.map((m) => m.email)).toEqual([
      "owner@example.invalid",
      "other@example.invalid",
    ]);
  });

  it("refuses a member who is not an administrator", async () => {
    // Reading the ledger is open to everyone. Deciding who may read it is not.
    const d = deps([member({ email: "guest@example.invalid", role: "member" })]);

    await expect(
      listHouseholdMembers(d, { email: "guest@example.invalid", tenantId: "t1" }),
    ).rejects.toBeInstanceOf(NotAnAdministrator);
  });

  it("refuses an administrator of a different household", async () => {
    // Being an administrator somewhere is not being one here. A token
    // carrying another household's claim must not reach this list.
    const d = deps([member()]);

    await expect(
      listHouseholdMembers(d, { email: "owner@example.invalid", tenantId: "somewhere-else" }),
    ).rejects.toBeInstanceOf(NotAnAdministrator);
  });

  it("checks the stored row rather than anything the caller supplied", async () => {
    // The role is never taken from the request. A claim is minted at sign-in,
    // and somebody demoted this morning would hold an administrator's token
    // until theirs expired.
    const d = deps([member({ role: "member" })]);

    await expect(listHouseholdMembers(d, admin)).rejects.toBeInstanceOf(NotAnAdministrator);
    expect(d.listMembers).toHaveBeenCalledWith("t1");
  });
});

describe("adding somebody", () => {
  it("adds them to this household, lowercased", async () => {
    // The identity provider's address is what the row is keyed by, so a
    // capital letter must not create a second person.
    const d = deps([member()]);

    const out = await addMember(d, admin, "  NewPerson@Example.Invalid ", "member", NOW);

    expect(out).toEqual({ email: "newperson@example.invalid", role: "member" });
    expect(d.put[0]).toMatchObject({
      email: "newperson@example.invalid",
      tenantId: "t1",
      role: "member",
    });
  });

  it("refuses an address that belongs to another household", async () => {
    // A move is two decisions — one household losing sight of somebody,
    // another gaining it — and only one is being made here.
    const d = deps([member()], "a-different-household");

    await expect(
      addMember(d, admin, "elsewhere@example.invalid", "member", NOW),
    ).rejects.toBeInstanceOf(AlreadySomebodyElses);
    expect(d.put).toHaveLength(0);
  });

  it("does not say which household that was", async () => {
    // Somebody adding an address they do not control should not learn where
    // else it is used.
    const d = deps([member()], "the-neighbours");

    const err = await addMember(d, admin, "elsewhere@example.invalid", "member", NOW).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).not.toContain("the-neighbours");
  });

  it("treats an existing member as a role change", async () => {
    // Which is what "make this person an administrator" has to mean.
    const d = deps([member(), member({ email: "guest@example.invalid", role: "member" })]);

    await addMember(d, admin, "guest@example.invalid", "admin", NOW);

    expect(d.put[0]).toMatchObject({ email: "guest@example.invalid", role: "admin" });
  });

  it("refuses a caller who is not an administrator", async () => {
    const d = deps([member({ email: "guest@example.invalid", role: "member" })]);

    await expect(
      addMember(d, { email: "guest@example.invalid", tenantId: "t1" }, "x@example.invalid", "admin", NOW),
    ).rejects.toBeInstanceOf(NotAnAdministrator);
    expect(d.put).toHaveLength(0);
  });
});

describe("removing somebody", () => {
  it("takes their access away", async () => {
    const d = deps([member(), member({ email: "guest@example.invalid", role: "member" })]);

    await removeMember(d, admin, "Guest@Example.Invalid");

    expect(d.deleted).toEqual(["guest@example.invalid"]);
  });

  it("refuses to remove the person asking", async () => {
    // A household with no administrator cannot add one back: the dashboard
    // is the only way in, and the capability it needs is the one that was
    // just removed.
    const d = deps([member()]);

    await expect(removeMember(d, admin, "owner@example.invalid")).rejects.toBeInstanceOf(
      CannotRemoveYourself,
    );
    expect(d.deleted).toHaveLength(0);
  });

  it("refuses somebody who is not a member of this household", async () => {
    // Otherwise an administrator could delete a row belonging to another
    // household by naming it.
    const d = deps([member()]);

    await expect(removeMember(d, admin, "stranger@example.invalid")).rejects.toBeInstanceOf(
      MemberNotFound,
    );
    expect(d.deleted).toHaveLength(0);
  });

  it("refuses a caller who is not an administrator", async () => {
    const d = deps([
      member(),
      member({ email: "guest@example.invalid", role: "member" }),
    ]);

    await expect(
      removeMember(d, { email: "guest@example.invalid", tenantId: "t1" }, "owner@example.invalid"),
    ).rejects.toBeInstanceOf(NotAnAdministrator);
    expect(d.deleted).toHaveLength(0);
  });
});

describe("rows that should not be trusted", () => {
  it("ignores one that does not parse rather than failing the call", async () => {
    const d = deps([{ email: "junk" }, member()]);

    await expect(listHouseholdMembers(d, admin)).resolves.toHaveLength(1);
  });

  it("ignores one belonging to another household, whatever the store returned", async () => {
    // Belt and braces over the store's own filter. This decides who may
    // change who sees a household's money, and should not be one `if` in an
    // adapter away from being wrong.
    const d = deps([member(), member({ email: "theirs@example.invalid", tenantId: "t2" })]);

    const out = await listHouseholdMembers(d, admin);

    expect(out.map((m) => m.email)).toEqual(["owner@example.invalid"]);
  });
});
