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

export interface Merchant {
  /** As it would appear in a bank description: capitals, often a town. */
  readonly name: string;
  /** TrueLayer's own category for this kind of spending. */
  readonly category: string;
  /** Typical spend range, in minor units. */
  readonly min: number;
  readonly max: number;
}

/** Everyday retail, weighted towards the ordinary in the generator. */
export const MERCHANTS: readonly Merchant[] = [
  { name: "TESCO STORES 3411", category: "PURCHASE", min: 3_20, max: 94_50 },
  { name: "SAINSBURYS SMKTS", category: "PURCHASE", min: 4_10, max: 88_00 },
  { name: "ASDA SUPERSTORE", category: "PURCHASE", min: 5_00, max: 102_30 },
  { name: "WAITROSE 442", category: "PURCHASE", min: 6_75, max: 76_40 },
  { name: "MARKS&SPENCER PLC", category: "PURCHASE", min: 4_50, max: 120_00 },
  { name: "GREGGS PLC", category: "PURCHASE", min: 1_80, max: 12_40 },
  { name: "PRET A MANGER", category: "PURCHASE", min: 3_40, max: 18_20 },
  { name: "COSTA COFFEE", category: "PURCHASE", min: 2_60, max: 14_00 },
  { name: "BOOTS THE CHEMIST", category: "PURCHASE", min: 2_99, max: 46_00 },
  { name: "SCREWFIX DIRECT", category: "PURCHASE", min: 7_50, max: 240_00 },
  { name: "B&Q LIMITED", category: "PURCHASE", min: 8_00, max: 310_00 },
  { name: "ARGOS LTD", category: "PURCHASE", min: 12_00, max: 420_00 },
  { name: "SHELL SERVICE STN", category: "PURCHASE", min: 35_00, max: 98_00 },
  { name: "BP CONNECT", category: "PURCHASE", min: 32_00, max: 95_00 },
  { name: "TRAINLINE.COM", category: "PURCHASE", min: 9_40, max: 186_00 },
  { name: "TFL TRAVEL CHARGE", category: "PURCHASE", min: 2_40, max: 28_60 },
  { name: "ROYAL MAIL GROUP", category: "PURCHASE", min: 1_95, max: 24_00 },
  { name: "AMAZON.CO.UK", category: "PURCHASE", min: 4_99, max: 260_00 },
];

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
