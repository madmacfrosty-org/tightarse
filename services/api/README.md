# services/api

Aggregation API behind the dashboard.

Grouping and summing happen here, in memory, not in DynamoDB — a family's
transaction volume is small enough that loading a partition and aggregating is
both correct and fast. If that ever stops being true, S3 + Athena is the
escape hatch.
