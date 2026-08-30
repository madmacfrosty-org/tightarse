/**
 * The domain: what this application knows, independent of how it is delivered or
 * where anything is stored.
 *
 * One entry point. The directories are namespaces that show the shape of the
 * domain rather than separate modules to import:
 *
 *   money            integer minor units, one currency at a time
 *   ledger/          transactions, accounts, balances
 *   categorisation/  rules as values, and what applying one produces
 *   household/       members, settings, bank consents
 *   reporting/       what the household spent, and what it is worth
 *   raw/             how the landing zone is laid out
 *   application/     the use cases, orchestrating the above through ports
 *   ports/           the edges, inbound and outbound
 *
 * It was `@tightarse/ports` and `@tightarse/domain` — one naming the edges and
 * one naming nothing at all. Ports are how the domain is reached; a schema is a
 * shape without a subject. The business logic still sitting in services and
 * agents moves in behind these names, one area at a time. See #43.
 */

export * from "./money.js";
export * from "./ledger/transaction.js";
export * from "./ledger/account.js";
export * from "./ledger/balance.js";
export * from "./ledger/reconciliation.js";
export * from "./categorisation/rules.js";
export * from "./categorisation/evaluate.js";
export * from "./categorisation/overrides.js";
export * from "./categorisation/evidence.js";
export * from "./categorisation/corpus.js";
export * from "./categorisation/preview.js";
export * from "./categorisation/taxonomy.js";
export * from "./categorisation/category.js";
export * from "./categorisation/seed.js";
export * from "./categorisation/merchants.js";
export * from "./categorisation/merchant-rules.js";
export * from "./categorisation/categorisation.js";
export * from "./categorisation/enrichment.js";
export * from "./categorisation/provider.js";
export * from "./categorisation/resolve.js";
export * from "./household/member.js";
export * from "./household/settings.js";
export * from "./household/consent.js";
export * from "./raw/keys.js";
export * from "./reporting/summary.js";
export * from "./reporting/categories.js";
export * from "./reporting/balances.js";
export * from "./reporting/coverage.js";
export * from "./reporting/transfers.js";
export * from "./reporting/reporting.js";
// Named rather than `export *`: `decide` and its argument type are the
// module's internals, tested directly but not offered to a driver.
export * from "./application/candidate.js";
export * from "./application/optimise.js";
export {
  categorise,
  type CategoriseDependencies,
  type CategoriseOptions,
  type CategoriseReport,
} from "./application/categorise.js";
export * from "./application/reconcile.js";
export * from "./application/inspect.js";
export * from "./application/categories.js";
export * from "./application/proposal.js";
export * from "./ports/index.js";
