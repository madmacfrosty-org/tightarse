export { DynamoStore, type DynamoStoreOptions } from "./dynamo-store";

// One adapter per port. Prefer these where a component needs one concern — a
// scheduled reconciliation has no business holding an interface that can write
// members.
export { TableAdapter, type TableOptions } from "./table";
export { DynamoTransactions } from "./transactions";
export { DynamoEnrichments } from "./enrichments";
export { DynamoCategorisations } from "./categorisations";
export { DynamoAccounts } from "./accounts";
export { DynamoBalances } from "./balances";
export { DynamoRuleSets } from "./rulesets";
export { DynamoHousehold } from "./household";
export {
  transactionItem,
  enrichmentItem,
  pendingItem,
  accountItem,
  consentItem,
  type TransactionItem,
} from "./items";
