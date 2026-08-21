/**
 * Money, and the conventions every part of this system obeys.
 *
 * First file in the domain because the conventions here are the ones this
 * repository has already been burned by leaving unwritten. Integer minor units,
 * never floats. One currency at a time, or an error rather than a plausible
 * wrong total.
 */

import { z } from "zod";

/** ISO-4217, e.g. GBP. */
export const Currency = z.string().length(3).regex(/^[A-Z]{3}$/);

/** Minor units (pence). Never use floats for money. */
export const Amount = z.number().int();

/**
 * ISO 4217 minor-unit exponents that are not 2.
 *
 * The overwhelming majority of currencies use 2 decimal places, so this lists
 * only the exceptions. Getting it wrong is not a rounding error: treating JPY
 * as 2-decimal overstates every amount a hundredfold.
 */
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  // Zero-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Four-decimal
  CLF: 4,
};

/** How many minor units make one major unit of this currency. */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Convert a provider amount to integer minor units.
 *
 * TrueLayer returns amounts as JSON numbers in major units — pounds with
 * decimals, not pence. That makes this the single most dangerous conversion in
 * the codebase: `12.99 * 100` is `1298.9999999999998` in IEEE 754, so dropping
 * the rounding loses a penny on roughly a quarter of real transactions, in the
 * direction that under-reports spending.
 *
 * Math.round is exact for the range banks produce: at most the currency's
 * declared precision, far inside 2^53 once scaled. Do not "simplify" this to a
 * truncation.
 *
 * The currency is required because the scale factor is not always 100. JPY has
 * no minor unit at all and KWD has three, so a hardcoded multiplier is wrong by
 * a factor of a hundred or ten respectively.
 *
 * Sign is preserved and is authoritative — TrueLayer signs debits negative and
 * credits positive, consistently across the 9,707 transactions measured.
 */
export function toMinorUnits(majorUnits: number, currency: string): number {
  if (!Number.isFinite(majorUnits)) {
    throw new Error(`Amount is not a finite number: ${majorUnits}`);
  }
  const scale = 10 ** minorUnitExponent(currency);
  return Math.round(majorUnits * scale);
}

/**
 * Guard against silently adding yen to pounds.
 *
 * Any aggregation over a mixed-currency set must convert first. Summing raw
 * `amount` across currencies produces a plausible-looking number that is simply
 * wrong, which is the worst kind of bug in a finance application — so this
 * throws rather than returning something defensible.
 */
export function assertSingleCurrency(items: ReadonlyArray<{ currency: string }>): string | null {
  if (items.length === 0) return null;
  const first = items[0]!.currency;
  const other = items.find((i) => i.currency !== first);
  if (other) {
    throw new Error(
      `Cannot aggregate across currencies (${first} and ${other.currency}) — convert to a base currency first`,
    );
  }
  return first;
}
