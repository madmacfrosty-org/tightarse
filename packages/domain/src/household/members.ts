import { Member } from "./member.js";
import type { Row } from "../ports/outbound/index.js";

/**
 * Who can see the household.
 *
 * The most consequential thing in the application. A row here is the whole
 * authorisation model: whoever holds that email at the identity provider sees
 * every transaction, every balance, and every bank the household has
 * connected. There is no second factor and no per-page permission behind it.
 *
 * So the capability is narrow and the guard is explicit. Everything here
 * refuses a caller who is not an administrator of the household they are
 * acting on — checked against the stored row rather than against a claim,
 * because a claim is minted at sign-in and somebody demoted this morning
 * would keep an administrator's token until theirs expired. For reading the
 * ledger that staleness is an acceptable trade; for deciding who may read the
 * ledger it is not.
 */

export interface MemberDirectoryDeps {
  readonly getMemberTenant: (email: string) => Promise<string | null>;
  readonly listMembers: (tenantId?: string) => Promise<Row[]>;
  readonly putMember: (member: Member) => Promise<void>;
  readonly deleteMember: (email: string) => Promise<void>;
}

/** The person making the request, from their verified token. */
export interface Actor {
  readonly email: string;
  readonly tenantId: string;
}

export class NotAnAdministrator extends Error {
  readonly statusCode = 403;
  constructor() {
    super("Only an administrator of this household can change who has access.");
  }
}

export class MemberNotFound extends Error {
  readonly statusCode = 404;
  constructor() {
    super("That person is not a member of this household.");
  }
}

export class AlreadySomebodyElses extends Error {
  readonly statusCode = 409;
  constructor(email: string) {
    // Does not say which household. Somebody adding an address they do not
    // control should not learn where else it is used.
    super(`${email} already has access to a different household.`);
  }
}

export class CannotRemoveYourself extends Error {
  readonly statusCode = 409;
  constructor() {
    // A household with no administrator cannot add one back: the dashboard
    // is the only way in, and the capability it needs is the one that was
    // just removed. The CLI could fix it, but that needs the table name and
    // AWS credentials, which is not where somebody should find themselves
    // after pressing a button.
    super("You cannot remove your own access. Ask another administrator.");
  }
}

/** Everyone with access, as the household's own list. */
export async function listHouseholdMembers(
  deps: MemberDirectoryDeps,
  actor: Actor,
): Promise<Array<{ email: string; role: "admin" | "member"; addedAt: string }>> {
  await requireAdmin(deps, actor);
  return readMembers(deps, actor.tenantId);
}

/**
 * Give somebody access.
 *
 * Refuses an address that already belongs to another household rather than
 * moving it. A move is two decisions — one household losing sight of
 * somebody, another gaining it — and only one of them is being made here.
 */
export async function addMember(
  deps: MemberDirectoryDeps,
  actor: Actor,
  email: string,
  role: "admin" | "member",
  now: Date = new Date(),
): Promise<{ email: string; role: "admin" | "member" }> {
  await requireAdmin(deps, actor);

  const normalised = normalise(email);
  const existing = await deps.getMemberTenant(normalised);
  if (existing !== null && existing !== actor.tenantId) {
    throw new AlreadySomebodyElses(normalised);
  }

  // Already a member is a role change rather than an error, which is what
  // pressing "make this person an administrator" has to mean.
  await deps.putMember({
    email: normalised,
    tenantId: actor.tenantId,
    addedAt: now.toISOString(),
    role,
  });
  return { email: normalised, role };
}

/** Take access away. */
export async function removeMember(
  deps: MemberDirectoryDeps,
  actor: Actor,
  email: string,
): Promise<{ email: string }> {
  await requireAdmin(deps, actor);

  const normalised = normalise(email);
  if (normalised === normalise(actor.email)) throw new CannotRemoveYourself();

  const members = await readMembers(deps, actor.tenantId);
  if (!members.some((m) => m.email === normalised)) throw new MemberNotFound();

  await deps.deleteMember(normalised);
  return { email: normalised };
}

/**
 * The caller must be an administrator of the household they are acting on.
 *
 * Two conditions, not one. Being an administrator somewhere is not being an
 * administrator here, and a token carrying another household's claim must not
 * reach this household's member list.
 */
async function requireAdmin(deps: MemberDirectoryDeps, actor: Actor): Promise<void> {
  const members = await readMembers(deps, actor.tenantId);
  const me = members.find((m) => m.email === normalise(actor.email));
  if (!me || me.role !== "admin") throw new NotAnAdministrator();
}

/**
 * The household's members, as rows that parse.
 *
 * Tolerates one that does not: a malformed row must not stop somebody seeing
 * or changing the rest, which is the same tolerance the consent reporting
 * already applies.
 */
async function readMembers(
  deps: MemberDirectoryDeps,
  tenantId: string,
): Promise<Array<{ email: string; role: "admin" | "member"; addedAt: string }>> {
  const rows = await deps.listMembers(tenantId);
  return rows
    .map((r) => Member.safeParse(r))
    .flatMap((p) => (p.success ? [p.data] : []))
    // Belt and braces over the store's own filter. This decides who may change
    // who can see a household's money, and it should not be one `if` in an
    // adapter away from being wrong.
    .filter((m) => m.tenantId === tenantId)
    // `addedAt` is required by the schema, so a row that parsed has one.
    // The optional spread that used to be here was a branch no test could
    // reach, which is the shape of a condition that is not really a
    // condition.
    .map((m) => ({ email: m.email, role: m.role, addedAt: m.addedAt }));
}

/** The identity provider's address, as the row stores it. */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}
