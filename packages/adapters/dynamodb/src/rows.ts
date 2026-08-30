/**
 * The whole table, for the two jobs that legitimately need it.
 *
 * Its own adapter rather than a method on another, because holding it is a
 * statement: this component may read every row a household has. Reconciliation
 * and the replay comparison need that; nothing else should be able to.
 */

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { TableRows } from "@tightarse/domain";
import { TableAdapter } from "./table.js";

export class DynamoTableRows extends TableAdapter implements TableRows {
  /**
   * Every row, following pagination to the end.
   *
   * A scan returns up to 1MB at a time. Stopping at the first page would compare
   * a fraction of the ledger and report a confident match.
   */
  async scanAll(): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
    const rows: Array<Record<string, unknown>> = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      rows.push(...((res.Items ?? []) as Array<Record<string, unknown>>));
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return rows;
  }
}
