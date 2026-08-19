import { describe, it, expect, vi } from "vitest";
import { DynamoTableRows } from "./rows";

/**
 * Pagination, tested where it now lives. It used to sit in the transform's
 * comparison code, which only ever wanted the complete set — a caller of a port
 * should not have to know that a scan arrives 1MB at a time.
 */
describe("scanning every row", () => {
  it("follows pagination to the end", async () => {
    // Stopping at the first page would compare a fraction of the ledger and
    // report a confident match, which is the failure this exists to prevent.
    const all = Array.from({ length: 250 }, (_, n) => ({ n }));
    let call = 0;
    const doc = {
      send: vi.fn(async () => {
        const page = all.slice(call * 100, call * 100 + 100);
        call += 1;
        return { Items: page, ...(call * 100 < all.length ? { LastEvaluatedKey: { n: call } } : {}) };
      }),
    } as never;
    const rows = new DynamoTableRows({ tableName: "Ledger", client: doc });
    expect(await rows.scanAll()).toHaveLength(250);
  });

  it("passes the last evaluated key back as the start of the next page", async () => {
    const starts: unknown[] = [];
    let call = 0;
    const doc = {
      send: vi.fn(async (cmd: any) => {
        starts.push(cmd.input.ExclusiveStartKey);
        call += 1;
        return call === 1 ? { Items: [], LastEvaluatedKey: { n: 1 } } : { Items: [] };
      }),
    } as never;
    await new DynamoTableRows({ tableName: "Ledger", client: doc }).scanAll();
    expect(starts).toEqual([undefined, { n: 1 }]);
  });

  it("returns nothing for an empty table rather than undefined", async () => {
    const doc = { send: vi.fn(async () => ({})) } as never;
    expect(await new DynamoTableRows({ tableName: "Ledger", client: doc }).scanAll()).toEqual([]);
  });
});
