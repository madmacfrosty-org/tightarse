/**
 * Generator combinators.
 *
 * A generator is `(rng) => T` and nothing more, so combining them is ordinary
 * function composition. This is the model `clojure.spec` and `test.check` use,
 * and the reason to want it here is that the interesting shapes are built from
 * smaller ones: a transaction picks a merchant, then derives an amount from
 * that merchant's own range. Written as one function, that dependency is buried
 * in the middle of a hundred lines. Written as `chain`, it is the signature.
 *
 * Deliberately not a library. `fast-check` gives the same combinators plus
 * shrinking, which is worth having for property tests and is not worth a
 * runtime dependency in the package that seeds an environment. The shape below
 * is small enough to read in one sitting and can be swapped for one later
 * without changing a single generator built on it.
 *
 * Every generator is a pure function of the supplied `rng`. Nothing here may
 * call `Math.random` or read a clock: the whole point of seeding is that the
 * same seed produces the same corpus, and one impure leaf makes a fixed test
 * dataset quietly stop being fixed.
 */

/** A source of randomness. `seeded` produces one; nothing else should. */
export type Rng = () => number;

/** A generator of `T`. */
export type Gen<T> = (rng: Rng) => T;

/** Always the same value. */
export const always =
  <T>(value: T): Gen<T> =>
  () =>
    value;

/** One of `xs`, uniformly. Throws on an empty list rather than returning undefined. */
export const pick = <T>(xs: readonly T[]): Gen<T> => {
  if (xs.length === 0) throw new Error("pick: nothing to pick from");
  return (rng) => xs[Math.floor(rng() * xs.length)]!;
};

/**
 * One of `xs`, by weight.
 *
 * Real ledgers are not uniform — a household has far more card purchases than
 * standing orders, and a generator that emits them equally produces data that
 * exercises the rare paths and misrepresents the common ones.
 */
export const weighted = <T>(xs: readonly (readonly [number, T])[]): Gen<T> => {
  const total = xs.reduce((n, [w]) => n + w, 0);
  if (total <= 0) throw new Error("weighted: weights must sum above zero");
  return (rng) => {
    let r = rng() * total;
    // Every element but the last competes on its weight; the last is what
    // remains. Written this way so there is no unreachable fallback after the
    // loop — floating point could otherwise leave a line no test can exercise.
    for (let i = 0; i < xs.length - 1; i += 1) {
      r -= xs[i]![0];
      if (r < 0) return xs[i]![1];
    }
    return xs[xs.length - 1]![1];
  };
};

/** An integer in `[lo, hi]`, inclusive at both ends. */
export const int =
  (lo: number, hi: number): Gen<number> =>
  (rng) =>
    lo + Math.floor(rng() * (hi - lo + 1));

/** Minor units in `[lo, hi]` — pence, never a float. Money is never generated as a decimal. */
export const minorUnits = (lo: number, hi: number): Gen<number> => int(lo, hi);

/** Transform the generated value. */
export const map =
  <A, B>(gen: Gen<A>, f: (a: A) => B): Gen<B> =>
  (rng) =>
    f(gen(rng));

/** A generator that depends on what an earlier one produced. */
export const chain =
  <A, B>(gen: Gen<A>, f: (a: A) => Gen<B>): Gen<B> =>
  (rng) =>
    f(gen(rng))(rng);

/** Fixed-length list. */
export const listOf =
  <T>(gen: Gen<T>, count: number): Gen<T[]> =>
  (rng) =>
    Array.from({ length: count }, () => gen(rng));

/**
 * An object whose fields are each generated.
 *
 * Field order is the declaration order, which matters: generators consume the
 * same `rng`, so reordering the fields changes every value after the first.
 * That is a property of any seeded generator and not a defect, but it does mean
 * a corpus is pinned to the shape of the code that produced it.
 */
export const record = <T extends Record<string, unknown>>(spec: {
  [K in keyof T]: Gen<T[K]>;
}): Gen<T> => {
  const entries = Object.entries(spec) as [keyof T, Gen<T[keyof T]>][];
  return (rng) => {
    const out = {} as T;
    for (const [key, gen] of entries) out[key] = gen(rng);
    return out;
  };
};

/** Present with probability `p`, absent otherwise — for the provider's optional fields. */
export const sometimes =
  <T>(gen: Gen<T>, p: number): Gen<T | undefined> =>
  (rng) =>
    rng() < p ? gen(rng) : undefined;
