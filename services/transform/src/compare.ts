/**
 * Compare two ledger tables over the rows the transform produces.
 *
 * The point is to make a change to the transform measurable against five years
 * of real data rather than against fixtures: replay the raw zone into a fresh
 * table, compare it with the live one, and read the differences.
 *
 * ## Scoped on purpose
 *
 * A replayed table will legitimately not match a live one, because the transform
 * is not the only writer. The categoriser writes enrichment rows, the household
 * writes settings and categorisation rules, the connect flow writes consents,
 * and an administrator writes members. None of those come from raw objects, so
 * a replayed table has none of them and a whole-table diff would drown in
 * differences that are not differences.
 *
 * So this compares only what a replay can produce, and says so in the report
 * rather than filtering silently — an unexplained subset is how a comparison
 * quietly stops meaning anything.
 */

import type { TableRows } from "@tightarse/domain";

export type Row = Readonly<Record<string, unknown>>;

/**
 * Every row, via the port.
 *
 * The pagination that used to live here is the adapter's now — this only ever
 * wanted the complete set, and a caller of a port should not have to know that
 * a scan arrives 1MB at a time.
 */
export async function scanAll(rows: TableRows): Promise<readonly Row[]> {
  return rows.scanAll();
}

/** What a row is, from its keys. Sort keys carry the kind; partition keys carry the shape. */
export function rowKind(row: Row): string {
  const pk = String(row["pk"] ?? "");
  const sk = String(row["sk"] ?? "");

  if (sk.startsWith("ACCOUNT#")) return "account";
  if (sk.startsWith("CONSENT#")) return "consent";
  if (sk === "SETTINGS") return "settings";
  if (sk === "RULES") return "rules";
  if (sk === "MEMBER") return "member";
  if (pk.includes("#PEND#")) return "pending";
  if (pk.includes("#BAL#")) return "balanceReading";
  // Transactions and enrichments share a partition and differ by a marker in
  // the sort key: <timestamp>#TX#<dedup> against <timestamp>#EN#<dedup>.
  if (pk.endsWith("#TX") && sk.includes("#TX#")) return "transaction";
  if (pk.endsWith("#TX") && sk.includes("#EN#")) return "enrichment";
  return "unknown";
}

/** The kinds a replay can produce, and therefore the only ones worth comparing. */
export const TRANSFORM_PRODUCED = ["transaction", "account", "pending", "balanceReading"] as const;

export function isTransformProduced(row: Row): boolean {
  return (TRANSFORM_PRODUCED as readonly string[]).includes(rowKind(row));
}

/**
 * Attributes recording when a row was written, not what it says.
 *
 * A replay writes rows now, so these differ on every single row and would
 * otherwise drown out anything real — the first live run reported 9790
 * differences, all of them these three.
 *
 * They are counted and reported rather than dropped in silence, because "we
 * ignored 9790 differences" is itself information, and an unexplained exclusion
 * is how a comparison stops being trusted.
 *
 *   ingestedAt    when the row was FIRST written
 *   expiresAt     TTL on a pending row, derived from write time
 *   lastSyncedAt  when an account was last successfully fetched
 *
 * `ingestedAt` is here only for rows written before it became write-once. It now
 * records the first observation and is preserved across rewrites, so a replay of
 * a table built after that change reproduces it exactly and this exclusion stops
 * being needed. Until the live table has been rebuilt, its rows still carry the
 * last-write value and would differ from a fresh replay. Removing it from this
 * list is the check that the rebuild actually happened.
 */
export const WRITE_TIME_ATTRIBUTES = ["ingestedAt", "expiresAt", "lastSyncedAt"] as const;

export interface Difference {
  readonly key: string;
  readonly kind: string;
  readonly attribute: string;
  readonly left: unknown;
  readonly right: unknown;
}

export interface ComparisonReport {
  /** Rows present in both, with every compared attribute equal. */
  readonly identical: number;
  readonly onlyInLeft: readonly string[];
  readonly onlyInRight: readonly string[];
  readonly differing: readonly Difference[];
  /**
   * How many differences fall on each attribute.
   *
   * The summary that matters. A list of sample rows hides the distribution, and
   * the distribution is the whole diagnosis: "9790 differences, all of them
   * ingestedAt" and "9790 differences spread across amount and currency" are
   * the same number and opposite findings.
   */
  readonly differingByAttribute: Readonly<Record<string, number>>;
  /** Differences ignored because they only record when a row was written. */
  readonly ignoredByAttribute: Readonly<Record<string, number>>;
  /** How many rows of each kind were compared, and how many were skipped. */
  readonly comparedByKind: Readonly<Record<string, number>>;
  readonly skippedByKind: Readonly<Record<string, number>>;
}

const identify = (row: Row): string => `${String(row["pk"])} | ${String(row["sk"])}`;

const count = (rows: readonly Row[], predicate: (r: Row) => boolean): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) if (predicate(r)) out[rowKind(r)] = (out[rowKind(r)] ?? 0) + 1;
  return out;
};

/**
 * Compare, attribute by attribute, over the union of attribute names.
 *
 * The union rather than the left side's keys, because an attribute that only
 * the right side has is exactly the kind of difference this exists to find —
 * comparing only the left's would miss a field that a change had added.
 *
 * Values are compared by their JSON form. These rows hold strings, numbers,
 * booleans and small objects, so this is sound here and gives readable output;
 * it would not be for anything holding a Set or a Date.
 */
export function compareRows(left: readonly Row[], right: readonly Row[]): ComparisonReport {
  const l = new Map(left.filter(isTransformProduced).map((r) => [identify(r), r]));
  const r = new Map(right.filter(isTransformProduced).map((row) => [identify(row), row]));

  const onlyInLeft: string[] = [];
  const onlyInRight: string[] = [];
  const ignoredByAttribute: Record<string, number> = {};
  const differing: Difference[] = [];
  let identical = 0;

  for (const [key, leftRow] of l) {
    const rightRow = r.get(key);
    if (!rightRow) {
      onlyInLeft.push(key);
      continue;
    }
    const names = new Set([...Object.keys(leftRow), ...Object.keys(rightRow)]);
    const found: Difference[] = [];
    for (const attribute of names) {
      const a = JSON.stringify(leftRow[attribute]) ?? "undefined";
      const b = JSON.stringify(rightRow[attribute]) ?? "undefined";
      if (a === b) continue;
      if ((WRITE_TIME_ATTRIBUTES as readonly string[]).includes(attribute)) {
        ignoredByAttribute[attribute] = (ignoredByAttribute[attribute] ?? 0) + 1;
        continue;
      }
      found.push({ key, kind: rowKind(leftRow), attribute, left: leftRow[attribute], right: rightRow[attribute] });
    }
    if (found.length === 0) identical += 1;
    else differing.push(...found);
  }

  for (const key of r.keys()) if (!l.has(key)) onlyInRight.push(key);

  const differingByAttribute: Record<string, number> = {};
  for (const d of differing) differingByAttribute[d.attribute] = (differingByAttribute[d.attribute] ?? 0) + 1;

  return {
    identical,
    onlyInLeft,
    onlyInRight,
    differing,
    differingByAttribute,
    ignoredByAttribute,
    comparedByKind: count(left, isTransformProduced),
    skippedByKind: count(left, (row) => !isTransformProduced(row)),
  };
}

/** True when the two tables agree on everything a replay could have produced. */
export function isMatch(report: ComparisonReport): boolean {
  return (
    report.onlyInLeft.length === 0 && report.onlyInRight.length === 0 && report.differing.length === 0
  );
}

export function formatReport(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push(`compared   ${report.identical + report.differing.length} rows`);
  for (const [kind, n] of Object.entries(report.comparedByKind)) lines.push(`  ${kind.padEnd(12)} ${n}`);

  const skipped = Object.entries(report.skippedByKind);
  if (skipped.length > 0) {
    // Named rather than silently dropped: these are rows a replay cannot
    // produce, and a reader has to know they were excluded deliberately.
    lines.push(`\nskipped    not produced by the transform, so not comparable`);
    for (const [kind, n] of skipped) lines.push(`  ${kind.padEnd(12)} ${n}`);
  }

  lines.push(`\nidentical  ${report.identical}`);
  lines.push(`differing  ${report.differing.length}`);
  lines.push(`only left  ${report.onlyInLeft.length}`);
  lines.push(`only right ${report.onlyInRight.length}`);

  const ignored = Object.entries(report.ignoredByAttribute).sort((a, b) => b[1] - a[1]);
  if (ignored.length > 0) {
    lines.push(`\nignored    differences that only record when a row was written`);
    for (const [attribute, n] of ignored) lines.push(`  ${attribute.padEnd(20)} ${n}`);
  }

  const byAttribute = Object.entries(report.differingByAttribute).sort((a, b) => b[1] - a[1]);
  if (byAttribute.length > 0) {
    lines.push(`\ndiffering by attribute`);
    for (const [attribute, n] of byAttribute) lines.push(`  ${attribute.padEnd(20)} ${n}`);
  }

  for (const d of report.differing.slice(0, 10)) {
    // Attribute names and row keys only. A value could be a description, which
    // is a merchant or a person's name, so values are summarised by type and
    // length rather than printed.
    const describe = (v: unknown) =>
      v === undefined ? "absent" : typeof v === "string" ? `string(${v.length})` : JSON.stringify(v);
    lines.push(`  ${d.kind.padEnd(11)} ${d.attribute.padEnd(20)} ${describe(d.left)} -> ${describe(d.right)}`);
  }
  if (report.differing.length > 10) lines.push(`  … and ${report.differing.length - 10} more`);

  return lines.join("\n");
}
