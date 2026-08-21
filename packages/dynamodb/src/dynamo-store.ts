/**
 * Every port at once, for composition roots that need several.
 *
 * A facade over seven adapters rather than one class of thirty methods. It exists
 * because a Lambda handler often needs two or three ports and constructing each
 * separately would build a client each time. It is not what application code
 * should depend on — depend on the ports.
 *
 * Delegation rather than inheritance, so each adapter satisfies exactly one port
 * and is testable and mutation-testable on its own. A single class spanning four
 * concerns was neither.
 */

import type {
  Accounts,
  Balances,
  Categorisations,
  Enrichments,
  Household,
  RuleSets,
  Transactions,
} from "@tightarse/domain";
import { DynamoAccounts } from "./accounts.js";
import { DynamoBalances } from "./balances.js";
import { DynamoCategorisations } from "./categorisations.js";
import { DynamoEnrichments } from "./enrichments.js";
import { DynamoHousehold } from "./household.js";
import { DynamoRuleSets } from "./rulesets.js";
import { DynamoTransactions } from "./transactions.js";
import type { TableOptions } from "./table.js";

export type DynamoStoreOptions = TableOptions;

export class DynamoStore
  implements Transactions, Enrichments, Categorisations, Accounts, Balances, RuleSets, Household
{
  private readonly transactions: DynamoTransactions;
  private readonly enrichments: DynamoEnrichments;
  private readonly categorisations: DynamoCategorisations;
  private readonly accounts: DynamoAccounts;
  private readonly balances: DynamoBalances;
  private readonly rulesets: DynamoRuleSets;
  private readonly household: DynamoHousehold;

  constructor(opts: DynamoStoreOptions) {
    this.transactions = new DynamoTransactions(opts);
    this.enrichments = new DynamoEnrichments({ ...opts, transactions: this.transactions });
    this.categorisations = new DynamoCategorisations(opts);
    this.accounts = new DynamoAccounts(opts);
    this.balances = new DynamoBalances(opts);
    this.rulesets = new DynamoRuleSets(opts);
    this.household = new DynamoHousehold(opts);
  }

  readonly listRange: Transactions["listRange"] = (...a) => this.transactions.listRange(...a);
  readonly listAccountRange: Transactions["listAccountRange"] = (...a) => this.transactions.listAccountRange(...a);
  readonly putTransactions: Transactions["putTransactions"] = (...a) => this.transactions.putTransactions(...a);
  readonly listPending: Transactions["listPending"] = (...a) => this.transactions.listPending(...a);
  readonly replacePending: Transactions["replacePending"] = (...a) => this.transactions.replacePending(...a);
  readonly listToEnrich: Enrichments["listToEnrich"] = (...a) => this.enrichments.listToEnrich(...a);
  readonly putEnrichment: Enrichments["putEnrichment"] = (...a) => this.enrichments.putEnrichment(...a);
  readonly deleteEnrichments: Enrichments["deleteEnrichments"] = (...a) => this.enrichments.deleteEnrichments(...a);
  readonly putCategorisation: Categorisations["putCategorisation"] = (...a) => this.categorisations.putCategorisation(...a);
  readonly listCategorisationHistory: Categorisations["listCategorisationHistory"] = (...a) => this.categorisations.listCategorisationHistory(...a);
  readonly listAccounts: Accounts["listAccounts"] = (...a) => this.accounts.listAccounts(...a);
  readonly putAccount: Accounts["putAccount"] = (...a) => this.accounts.putAccount(...a);
  readonly putBalances: Accounts["putBalances"] = (...a) => this.accounts.putBalances(...a);
  readonly putBalanceReading: Balances["putBalanceReading"] = (...a) => this.balances.putBalanceReading(...a);
  readonly listBalanceReadings: Balances["listBalanceReadings"] = (...a) => this.balances.listBalanceReadings(...a);
  readonly markBalanceReadingDirty: Balances["markBalanceReadingDirty"] = (...a) => this.balances.markBalanceReadingDirty(...a);
  readonly clearBalanceReadingDirty: Balances["clearBalanceReadingDirty"] = (...a) => this.balances.clearBalanceReadingDirty(...a);
  readonly listRuleSets: RuleSets["listRuleSets"] = (...a) => this.rulesets.listRuleSets(...a);
  readonly listRuleSetHistory: RuleSets["listRuleSetHistory"] = (...a) => this.rulesets.listRuleSetHistory(...a);
  readonly putRuleSetVersion: RuleSets["putRuleSetVersion"] = (...a) => this.rulesets.putRuleSetVersion(...a);
  readonly getCustomRules: RuleSets["getCustomRules"] = (...a) => this.rulesets.getCustomRules(...a);
  readonly putCustomRules: RuleSets["putCustomRules"] = (...a) => this.rulesets.putCustomRules(...a);
  readonly getMemberTenant: Household["getMemberTenant"] = (...a) => this.household.getMemberTenant(...a);
  readonly putMember: Household["putMember"] = (...a) => this.household.putMember(...a);
  readonly deleteMember: Household["deleteMember"] = (...a) => this.household.deleteMember(...a);
  readonly listMembers: Household["listMembers"] = (...a) => this.household.listMembers(...a);
  readonly getSettings: Household["getSettings"] = (...a) => this.household.getSettings(...a);
  readonly putSettings: Household["putSettings"] = (...a) => this.household.putSettings(...a);
  readonly listConsents: Household["listConsents"] = (...a) => this.household.listConsents(...a);
  readonly putConsent: Household["putConsent"] = (...a) => this.household.putConsent(...a);
}
