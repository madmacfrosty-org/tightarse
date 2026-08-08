# agents

Strands agents (TypeScript SDK), deployed to Bedrock AgentCore Runtime.

Planned:
- `categoriser` — assigns categories to transactions, writing TransactionEnrichment
  items. Never mutates a Transaction.
- `insights` — natural-language questions over the ledger, surfaced in the dashboard.

AgentCore Runtime takes a container from ECR (Express + Docker for TypeScript);
direct code deployment is Python-only.
