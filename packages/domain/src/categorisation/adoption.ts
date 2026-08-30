import { z } from "zod";

/**
 * Which rule sets a tenant uses, and in what order.
 *
 * Precedence used to be a number carried by the set itself. That cannot survive
 * a set owned by anything larger than one household: the same shared set will
 * sit above one tenant's own rules and below another's, and a single `order`
 * on the set cannot express both. So precedence moves to the tenant's decision
 * to use it — the adoption — and the set says nothing about where it ranks.
 *
 * **Precedence is position in this list, not a number on a row.** A number
 * invites two sets to hold the same one, and two sets at equal rank were broken
 * by comparing their ids, which is deterministic and meaningless. It had already
 * landed on the wrong set once: `provider` sorts before `provider-types` and is
 * the id discarded at read, so the legacy set won every tie and its answers were
 * thrown away. A list has no equal ranks to break.
 *
 * Adopting REFERENCES a set at a pinned version; it never copies its rules.
 * Copying guarantees drift, and drift in rules is silent — a shared set improves
 * and yours quietly does not. Pinning means one source of truth while nothing
 * changes a household's categories without them accepting it: a new version
 * arrives as a proposal, reviewed and accepted like any other. Published
 * versions are immutable, so the pin costs nothing to hold.
 */

export const Adoption = z.object({
  /** The set being used. May be owned by this tenant or by nobody in particular. */
  setId: z.string().min(1),
  /**
   * The exact version in force.
   *
   * Pinned deliberately. A shared set that improved under a household without
   * them accepting it would recategorise their ledger on somebody else's
   * schedule.
   */
  version: z.number().int().positive(),
  /** When this tenant adopted it. Provenance, not precedence. */
  adoptedAt: z.string(),
  /**
   * The set this replaced, where it replaced one.
   *
   * Explicit, because replacement was previously INFERRED from a set id
   * changing — which is the wrong thing to infer it from. A rename and a
   * successor look identical from the outside, and the two behaved very
   * differently: one rewrote attribution, the other did not. Saying so removes
   * the ambiguity rather than resolving it by convention.
   */
  supersedes: z.string().min(1).optional(),
});
export type Adoption = z.infer<typeof Adoption>;

/**
 * A tenant's rule state: every set in force, most trusted first.
 *
 * Ordered, and the order is the whole meaning. Index 0 outranks index 1.
 */
export const Adoptions = z.array(Adoption);
export type Adoptions = z.infer<typeof Adoptions>;

/** Set precedence, as the resolver and the evaluator want it. */
export interface SetPrecedence {
  readonly setId: string;
  readonly order: number;
}

/**
 * Precedence from position.
 *
 * The index is the rank, so the numbers exist only at this boundary and cannot
 * be authored, collided or drifted. Inserting a set between two others is an
 * insertion rather than a renumbering of everything below it.
 */
export function precedenceOf(adoptions: Adoptions): SetPrecedence[] {
  return adoptions.map((a, index) => ({ setId: a.setId, order: index }));
}

/** The version of a set a tenant has pinned, if they use it at all. */
export function pinnedVersion(
  adoptions: Adoptions,
  setId: string,
): number | undefined {
  return adoptions.find((a) => a.setId === setId)?.version;
}

/**
 * Adopt a set, replacing whatever it supersedes.
 *
 * Replacement is a single operation because doing it in two leaves a window
 * where both compete — which is the state that hid a category behind a payment
 * rail. The replacement takes the position of the set it replaces, since
 * adopting a successor is not a statement about wanting it ranked differently.
 */
export function adopt(adoptions: Adoptions, next: Adoption): Adoptions {
  const replacing = next.supersedes;
  const at =
    replacing === undefined
      ? -1
      : adoptions.findIndex((a) => a.setId === replacing);

  const without = adoptions.filter(
    (a) => a.setId !== next.setId && a.setId !== replacing,
  );
  if (at < 0) return [...without, next];

  const out = [...without];
  out.splice(Math.min(at, out.length), 0, next);
  return out;
}
