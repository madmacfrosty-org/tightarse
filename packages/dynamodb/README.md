# @tightarse/ledger

DynamoDB access. Key construction comes from `@tightarse/schema` — no `T#…`
strings are built here.

## Layout

```
pk   T#<tenant>#TX
sk   <timestamp>#TX#<dedupKey>     transaction
sk   <timestamp>#EN#<dedupKey>     its enrichment

gsi1  per-account history
gsi2  sparse — the categoriser's backlog, and nothing else
```

Row kind sits after the timestamp so one `between` returns transactions and
their enrichments together, for any range.

## Notes

**Writes are plain puts.** A settled booking date is stable and the sort key
embeds the dedup key, so replaying the whole raw landing zone converges on the
same rows rather than duplicating. No read-before-write.

**Enrichment is transactional.** Storing an enrichment also clears the
transaction's gsi2 marker, in one `TransactWriteItems`. Two separate writes
would leave a window where a crash either loses the enrichment or re-queues
finished work.

**Pending is a cache.** `replacePending` deletes and rewrites the whole
partition for an account, because pending transactions change amount, change id
on settlement, and vanish. A TTL backstops a sync that stops running.

**Batch writes retry.** `BatchWriteItem` returns `UnprocessedItems` on
throttling *without failing*, so ignoring the response silently drops rows.

## Tests

```sh
npm test -w @tightarse/ledger            # pure item tests only

# integration, against either a real table or DynamoDB Local
LEDGER_TEST_TABLE=<name> AWS_PROFILE=tightarse-dev npm test -w @tightarse/ledger
LEDGER_TEST_TABLE=Ledger LEDGER_TEST_ENDPOINT=http://localhost:8000 npm test -w @tightarse/ledger
```

Integration tests skip when `LEDGER_TEST_TABLE` is unset, so CI without
credentials stays green. They write under a throwaway `itest-<ts>` tenant and
delete it afterwards — they must never leave rows in a table that also holds
real financial data.
