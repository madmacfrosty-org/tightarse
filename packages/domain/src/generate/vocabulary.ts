/**
 * The words a generated ledger is made of.
 *
 * Two rules govern everything here, and they pull in opposite directions.
 *
 * **Use real names.** Invented merchants were the previous approach and they
 * cost realism for nothing: a bank description is shaped by the retailer that
 * issued it, and fixtures that read like nothing in the world ratify bugs a
 * real description would have caught. A high-street name in a list discloses
 * nothing about anybody.
 *
 * **Never source them from the captures.** Each individual name is harmless;
 * the SET of merchants a household actually uses is its shopping profile, and
 * the set of people it pays is its address book. Everything below is written
 * from general knowledge. Nothing here was read out of the raw zone, and
 * nothing here may be added by looking at it — that is how a fixture file comes
 * to hold a real description, which has happened once already.
 *
 * People are well-known historical figures for the same reason merchants are
 * real: transfers between people are a large part of any ledger, the payee name
 * shapes the description, and a famous name is public and unmistakably not the
 * household's actual payee. Living private individuals must never appear.
 */

/**
 * Merchants come from the domain, not from here.
 *
 * `@tightarse/domain`'s `merchants.ts` is the single list: it drives both the
 * seeded rules and the descriptions below, so a generated transaction is
 * matched by a generated rule by construction. Keeping a second list here is
 * how the two stopped agreeing, and why seeded data used to arrive entirely
 * uncategorised.
 */
export {
  describableMerchants,
  MERCHANTS,
  type Merchant,
} from "../categorisation/merchants.js";

/** Cash. Its own category in the provider's taxonomy. */
export const ATM_LOCATIONS: readonly string[] = [
  "LINK ATM HIGH ST",
  "CASH WITHDRAWAL BRANCH",
  "LINK ATM STATION RD",
];

/** Direct debit originators — the names that appear on a mandate. */
export const DIRECT_DEBIT_ORIGINATORS: readonly {
  name: string;
  min: number;
  max: number;
}[] = [
  { name: "BRITISH GAS", min: 48_00, max: 190_00 },
  { name: "THAMES WATER", min: 22_00, max: 64_00 },
  { name: "EDF ENERGY", min: 45_00, max: 175_00 },
  { name: "BT GROUP PLC", min: 28_00, max: 72_00 },
  { name: "TV LICENCE", min: 13_25, max: 13_25 },
  { name: "COUNCIL TAX", min: 120_00, max: 260_00 },
  { name: "AVIVA INSURANCE", min: 18_50, max: 96_00 },
];

/**
 * Well-known figures, for money moving between people.
 *
 * All long dead and internationally known, so no living private individual is
 * implied. UK bank descriptions usually carry an initial and a surname, which
 * is what `payeeName` below produces.
 */
export const PEOPLE: readonly { first: string; last: string }[] = [
  { first: "Ada", last: "Lovelace" },
  { first: "Alan", last: "Turing" },
  { first: "Grace", last: "Hopper" },
  { first: "Isaac", last: "Newton" },
  { first: "Rosalind", last: "Franklin" },
  { first: "Charles", last: "Babbage" },
  { first: "Mary", last: "Seacole" },
  { first: "Michael", last: "Faraday" },
  { first: "Emmeline", last: "Pankhurst" },
  { first: "Alexander", last: "Fleming" },
  { first: "Dorothy", last: "Hodgkin" },
  { first: "William", last: "Beveridge" },
];

/** Employers, for the credit that makes a current account work. */
export const EMPLOYERS: readonly string[] = [
  "NORTHWIND LTD SALARY",
  "ACME HOLDINGS PAYROLL",
  "BRIDGEWATER LLP SAL",
];

/**
 * How a payee reads in a description.
 *
 * Banks vary: some send the full name, most an initial and surname, some
 * uppercase the lot. A generator emitting only one form would let code depend
 * on a shape the real feed does not guarantee.
 */
export function payeeName(
  person: { first: string; last: string },
  form: "initial" | "full" | "surname",
): string {
  switch (form) {
    case "initial":
      return `${person.first[0]!} ${person.last}`.toUpperCase();
    case "full":
      return `${person.first} ${person.last}`.toUpperCase();
    case "surname":
      return person.last.toUpperCase();
  }
}
