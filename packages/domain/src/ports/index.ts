/**
 * Ports: the edges of the domain, in both directions.
 *
 * `outbound` is what the application needs of the world — a store, a bucket, a
 * bank. `inbound` is what it offers to whatever drives it. Seventeen against one
 * today, which is the shape of a codebase that has modelled what it calls far
 * more carefully than what it offers.
 *
 * `DateRange` sits here rather than in either, because both use it and neither
 * owns it. It lived in the adapter once, which is the inversion this package
 * exists to fix: a range of dates is domain vocabulary, and an adapter's job is
 * to satisfy a request for one rather than to define what one is.
 */

/**
 * A date range, inclusive at both ends.
 */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export * from "./outbound/index.js";
export * from "./inbound/index.js";
