# services/ingest

Scheduled daily pull from TrueLayer into the ledger.

Deterministic and agent-free by design: this is the writer of record for
financial data. Agents read what this writes; they never modify it.

Runs daily rather than hourly because unattended open banking access is capped
at four calls per 24 hours for each account, endpoint and consent —
Article 36(5)(b) of Commission Delegated Regulation (EU) 2018/389.
