# @tightarse/ledger

DynamoDB access. All key construction comes from `@tightarse/schema` — do not
build `TENANT#...` strings here.

Writes are upserts. Pending transactions can change id when they settle, so
ingest deduplicates on a composite of account, date, amount and description
rather than trusting the provider id alone.
