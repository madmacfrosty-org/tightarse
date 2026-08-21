import { describe, it, expect } from "vitest";
import {
  compareRows,
  formatReport,
  isMatch,
  isTransformProduced,
  rowKind,
  scanAll,
  type Row,
} from "../src/compare";

/**
 * Comparing a replayed table with the live one.
 *
 * The scoping is the part worth testing. A replay produces transactions,
 * accounts and pending rows and nothing else, so a comparison that included
 * enrichments would report thousands of differences that are not differences —
 * and a comparison nobody trusts is worse than none, because it gets ignored
 * at the moment it finally has something to say.
 */

const txn = (over: Partial<Row> = {}): Row => ({
  pk: "T#frost#TX",
  sk: "2026-03-15T00:00:00Z#TX#n:abc",
  kind: "TX",
  amount: -1299,
  currency: "GBP",
  ...over,
});

describe("telling one kind of row from another", () => {
  it.each([
    ["transaction", { pk: "T#frost#TX", sk: "2026-03-15T00:00:00Z#TX#n:abc" }],
    ["enrichment", { pk: "T#frost#TX", sk: "2026-03-15T00:00:00Z#EN#n:abc" }],
    ["account", { pk: "T#frost", sk: "ACCOUNT#acc-1" }],
    ["pending", { pk: "T#frost#PEND#acc-1", sk: "2026-03-15T00:00:00Z#p-1" }],
    ["consent", { pk: "T#frost", sk: "CONSENT#c-1" }],
    ["settings", { pk: "T#frost", sk: "SETTINGS" }],
    ["rules", { pk: "T#frost", sk: "RULES" }],
    ["member", { pk: "MEMBER#a@example.com", sk: "MEMBER" }],
  ])("recognises a %s", (expected, row) => {
    expect(rowKind(row)).toBe(expected);
  });

  it("separates a transaction from its enrichment, which share a partition", () => {
    // They differ only by a marker in the sort key. Getting this wrong would
    // compare enrichments as though a replay should have produced them.
    const transaction = { pk: "T#frost#TX", sk: "2026-03-15T00:00:00Z#TX#n:abc" };
    const enrichment = { pk: "T#frost#TX", sk: "2026-03-15T00:00:00Z#EN#n:abc" };
    expect(isTransformProduced(transaction)).toBe(true);
    expect(isTransformProduced(enrichment)).toBe(false);
  });
});

describe("what gets compared", () => {
  const live: Row[] = [
    txn(),
    { pk: "T#frost", sk: "ACCOUNT#acc-1", displayName: "Current" },
    { pk: "T#frost#TX", sk: "2026-03-15T00:00:00Z#EN#n:abc", category: "Groceries" },
    { pk: "T#frost", sk: "SETTINGS", enrichment: "rules" },
    { pk: "MEMBER#a@example.com", sk: "MEMBER" },
  ];

  it("ignores rows a replay could never have produced", () => {
    // The categoriser writes enrichments, the household writes settings, an
    // administrator writes members. A fresh replayed table has none of them.
    const replayed: Row[] = [txn(), { pk: "T#frost", sk: "ACCOUNT#acc-1", displayName: "Current" }];
    const report = compareRows(live, replayed);
    expect(isMatch(report)).toBe(true);
    expect(report.identical).toBe(2);
  });

  it("says what it skipped rather than filtering in silence", () => {
    // An unexplained subset is how a comparison stops meaning anything.
    const report = compareRows(live, [txn()]);
    expect(report.skippedByKind).toEqual({ enrichment: 1, settings: 1, member: 1 });
  });

  it("counts what it did compare, by kind", () => {
    const report = compareRows(live, live);
    expect(report.comparedByKind).toEqual({ transaction: 1, account: 1 });
  });
});

describe("finding real differences", () => {
  it("reports an attribute whose value changed", () => {
    // The case this exists for: a change to the transform that alters a stored
    // value across five years of history.
    const report = compareRows([txn({ amount: -1299 })], [txn({ amount: 1299 })]);
    expect(report.identical).toBe(0);
    expect(report.differing).toHaveLength(1);
    expect(report.differing[0]).toMatchObject({ attribute: "amount", left: -1299, right: 1299 });
  });

  it("reports an attribute the replay added, not just ones it changed", () => {
    // Compared over the union of attribute names. Using only the left side's
    // would miss a field a change had introduced, which is exactly the sort of
    // thing worth catching.
    const report = compareRows([txn()], [txn({ runningBalance: 5000 })]);
    expect(report.differing.map((d) => d.attribute)).toContain("runningBalance");
  });

  it("reports an attribute the replay dropped", () => {
    const report = compareRows([txn({ merchantName: "SHOP" })], [txn()]);
    expect(report.differing[0]).toMatchObject({ attribute: "merchantName", right: undefined });
  });

  it("reports a row missing from the replay, which means the raw object is gone", () => {
    // The recovery property this whole mechanism tests: if raw cannot rebuild a
    // row, the landing zone is not the backup it is claimed to be.
    const missing = txn({ sk: "2026-04-01T00:00:00Z#TX#n:def" });
    const report = compareRows([txn(), missing], [txn()]);
    expect(report.onlyInLeft).toHaveLength(1);
    expect(report.onlyInLeft[0]).toContain("n:def");
  });

  it("reports a row only the replay has", () => {
    const extra = txn({ sk: "2026-04-01T00:00:00Z#TX#n:def" });
    const report = compareRows([txn()], [txn(), extra]);
    expect(report.onlyInRight).toHaveLength(1);
  });

  it("does not call it a match when anything differs", () => {
    expect(isMatch(compareRows([txn()], [txn({ amount: 1 })]))).toBe(false);
    expect(isMatch(compareRows([txn()], []))).toBe(false);
    expect(isMatch(compareRows([], [txn()]))).toBe(false);
    expect(isMatch(compareRows([txn()], [txn()]))).toBe(true);
  });
});

describe("the report", () => {
  it("never prints a stored value", () => {
    // A description is a merchant, a person's name, or an employer. The report
    // is something you paste into an issue, so values are summarised by type
    // and length rather than shown.
    const report = compareRows(
      [txn({ description: "HARBOUR VIEW BISTRO HULL GB" })],
      [txn({ description: "SOMETHING ELSE ENTIRELY" })],
    );
    const text = formatReport(report);
    expect(text).not.toContain("HARBOUR VIEW");
    expect(text).not.toContain("SOMETHING ELSE");
    expect(text).toContain("description");
  });

  it("names the row kinds it skipped rather than dropping them silently", () => {
    // A replay cannot produce an enrichment — that comes from the categoriser,
    // not from a raw provider object. Leaving them out of the report without
    // saying so would make a reader think the comparison covered the whole table.
    const enrichment = {
      pk: "T#frost#TX",
      sk: "2026-03-15T00:00:00Z#EN#n:1",
      kind: "EN",
      category: "Groceries",
    };
    const text = formatReport(compareRows([txn(), enrichment], [txn(), enrichment]));
    expect(text).toContain("not produced by the transform");
    expect(text).toContain("enrichment");
  });

  it("truncates a long list rather than printing thousands of lines", () => {
    const many = Array.from({ length: 50 }, (_, i) => txn({ sk: `2026-03-15T00:00:00Z#TX#n:${i}` }));
    const changed = many.map((m) => ({ ...m, amount: 1 }));
    const text = formatReport(compareRows(many, changed));
    expect(text).toContain("and 40 more");
  });
});

describe("rows it does not recognise", () => {
  it("calls an unfamiliar row unknown and leaves it out of the comparison", () => {
    // A new row kind added elsewhere must not be silently treated as something
    // a replay should have produced, or every run reports it missing.
    const odd = { pk: "SOMETHING#new", sk: "ELSE" };
    expect(rowKind(odd)).toBe("unknown");
    expect(isTransformProduced(odd)).toBe(false);
  });

  it("tolerates a row with no keys at all rather than throwing", () => {
    expect(rowKind({})).toBe("unknown");
  });

  it("omits the skipped section entirely when nothing was skipped", () => {
    // Printing an empty heading trains people to skim past it.
    expect(formatReport(compareRows([txn()], [txn()]))).not.toContain("skipped");
  });
});

describe("differences that only say when a row was written", () => {
  it("does not count ingestedAt as a difference", () => {
    // A replay writes rows now, so this differs on every single row. The first
    // live run reported 9790 differences and every one was write-time metadata.
    const report = compareRows(
      [txn({ ingestedAt: "2026-01-01T00:00:00.000Z" })],
      [txn({ ingestedAt: "2026-08-15T12:00:00.000Z" })],
    );
    expect(isMatch(report)).toBe(true);
    expect(report.identical).toBe(1);
  });

  it("counts and names what it ignored rather than hiding it", () => {
    // "We ignored 9790 differences" is itself information, and an unexplained
    // exclusion is how a comparison stops being trusted.
    const report = compareRows(
      [txn({ ingestedAt: "a", expiresAt: 1, lastSyncedAt: "x" })],
      [txn({ ingestedAt: "b", expiresAt: 2, lastSyncedAt: "y" })],
    );
    expect(report.ignoredByAttribute).toEqual({ ingestedAt: 1, expiresAt: 1, lastSyncedAt: 1 });
    expect(formatReport(report)).toContain("ingestedAt");
  });

  it("still reports a real difference on a row whose timestamps also moved", () => {
    // The failure that would matter: ignoring the timestamp must not make the
    // whole row count as identical.
    const report = compareRows(
      [txn({ ingestedAt: "a", amount: -1299 })],
      [txn({ ingestedAt: "b", amount: 1299 })],
    );
    expect(isMatch(report)).toBe(false);
    expect(report.differingByAttribute).toEqual({ amount: 1 });
  });

  it("summarises differences by attribute, because the distribution is the diagnosis", () => {
    // "9790 differences, all ingestedAt" and "9790 spread across amount" are
    // the same number and opposite findings. Sample rows hide that.
    const rows = Array.from({ length: 5 }, (_, i) => txn({ sk: `2026-03-15T00:00:00Z#TX#n:${i}` }));
    const changed = rows.map((r) => ({ ...r, amount: 1, currency: "EUR" }));
    expect(compareRows(rows, changed).differingByAttribute).toEqual({ amount: 5, currency: 5 });
  });
});

describe("balance readings in a comparison", () => {
  it("recognises one and compares it, because a replay produces them", () => {
    // They are transform output, rebuilt from the raw zone like everything
    // else. Leaving them out would mean a replay silently stopped being a
    // complete rebuild.
    const reading = { pk: "T#frost#BAL#acc-1", sk: "2026-03-15T05:00:00.000Z", balance: 1234 };
    expect(rowKind(reading)).toBe("balanceReading");
    expect(isTransformProduced(reading)).toBe(true);
  });
});
