export { DynamoStore, type DynamoStoreOptions } from "./dynamo-store.js";

// One adapter per port. Prefer these where a component needs one concern — a
// scheduled reconciliation has no business holding an interface that can write
// members.
export { TableAdapter, type TableOptions } from "./table.js";
export { DynamoTransactions } from "./transactions.js";
export { DynamoCategorisations } from "./categorisations.js";
export { DynamoAccounts } from "./accounts.js";
export { DynamoBalances } from "./balances.js";
export { DynamoRuleSets } from "./rulesets.js";
export { DynamoHousehold } from "./household.js";
export { DynamoTableRows } from "./rows.js";
export {
  transactionItem,
  pendingItem,
  accountItem,
  consentItem,
  type TransactionItem,
} from "./items.js";
