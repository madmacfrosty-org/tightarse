import type { CategoryLabel } from "./taxonomy.js";

/**
 * Merchants, as data — the one place a merchant is described.
 *
 * This list drives two things that used to be written twice and could drift:
 *
 *  - the **rules** a household starts with. `merchant-rules.ts` groups these by
 *    category and emits one pattern per category, so adding a supermarket here
 *    adds it to the seeded rule set.
 *  - the **descriptions** generated test data uses. `@tightarse/fixtures` reads
 *    the same entries, so a generated transaction is matched by a generated
 *    rule BY CONSTRUCTION rather than by somebody keeping two lists in step.
 *
 * The second is why generated data used to show a wall of `DEBIT`: the
 * transactions and the rules came from different vocabularies and had no reason
 * to agree.
 *
 * These are deliberately generic UK chains that apply to anyone. This
 * repository is public, so a list curated from one household's statements would
 * publish where that household shops. Nothing here may be added by reading
 * stored responses — an individual name discloses nothing, a list assembled by
 * looking is a profile.
 */

export interface Merchant {
  /**
   * A regular expression FRAGMENT, as it appears inside an alternation.
   *
   * Not an escaped literal, deliberately. Real descriptions carry the
   * possessive, the abbreviation and the trailing space — `SAINSBURY'?S?`,
   * `TK ?MAXX`, `BP ` — and one entry needs a negative lookahead: `UBER` must
   * not claim `UBER EATS`, because every seeded rule is an `assert` and two
   * asserts on one transaction is a CONFLICT that yields no category at all.
   * Escaping these would quietly turn working rules into conflicting ones.
   */
  readonly match: string;
  /** The spending category this merchant implies. */
  readonly category: CategoryLabel;
  /**
   * How it reads in a bank description, when this merchant is used to generate
   * data. Omitted where the entry exists only to be matched.
   */
  readonly description?: string;
  /** Typical spend as [min, max] in MINOR units, for generated amounts. */
  readonly spend?: readonly [number, number];
}

/**
 * Every merchant, flat.
 *
 * Grouped into patterns by category at the point of use, so the order here is
 * for a reader's benefit and carries no meaning.
 */
export const MERCHANTS: readonly Merchant[] = [
  // Groceries
  {
    match: "TESCO",
    category: "Groceries",
    description: "TESCO STORES 3411",
    spend: [3_20, 94_50],
  },
  {
    match: "SAINSBURY'?S?",
    category: "Groceries",
    description: "SAINSBURYS SMKTS",
    spend: [4_10, 88_00],
  },
  {
    match: "ASDA",
    category: "Groceries",
    description: "ASDA SUPERSTORE",
    spend: [5_00, 102_30],
  },
  {
    match: "WAITROSE",
    category: "Groceries",
    description: "WAITROSE 442",
    spend: [6_75, 76_40],
  },
  {
    match: "ALDI",
    category: "Groceries",
    description: "ALDI STORES LTD",
    spend: [4_00, 71_20],
  },
  {
    match: "LIDL",
    category: "Groceries",
    description: "LIDL GB LONDON",
    spend: [3_80, 68_90],
  },
  { match: "MORRISON'?S?", category: "Groceries" },
  { match: "CO-?OP", category: "Groceries" },
  { match: "ICELAND", category: "Groceries" },
  { match: "OCADO", category: "Groceries" },
  { match: "BOOKER", category: "Groceries" },
  {
    match: "M&?S\\s*(SIMPLY\\s*)?FOOD",
    category: "Groceries",
    description: "M&S SIMPLY FOOD",
    spend: [4_50, 42_00],
  },

  // Eating out
  {
    match: "COSTA",
    category: "Eating Out",
    description: "COSTA COFFEE",
    spend: [2_60, 14_00],
  },
  {
    match: "GREGGS",
    category: "Eating Out",
    description: "GREGGS PLC",
    spend: [1_80, 12_40],
  },
  {
    match: "PRET",
    category: "Eating Out",
    description: "PRET A MANGER",
    spend: [3_40, 18_20],
  },
  { match: "STARBUCKS", category: "Eating Out" },
  { match: "CAFFE NERO", category: "Eating Out" },
  { match: "SUBWAY", category: "Eating Out" },
  { match: "NANDO'?S", category: "Eating Out" },
  { match: "WAGAMAMA", category: "Eating Out" },
  { match: "PIZZA (EXPRESS|HUT)", category: "Eating Out" },
  { match: "DOMINO'?S", category: "Eating Out" },
  { match: "MCDONALD'?S", category: "Eating Out" },
  { match: "KFC", category: "Eating Out" },
  { match: "BURGER KING", category: "Eating Out" },
  {
    match: "DELIVEROO",
    category: "Eating Out",
    description: "DELIVEROO LONDON",
    spend: [12_00, 58_00],
  },
  { match: "JUST\\s*EAT", category: "Eating Out" },
  { match: "UBER\\s*EATS", category: "Eating Out" },

  // Fuel
  {
    match: "SHELL",
    category: "Fuel",
    description: "SHELL SERVICE STN",
    spend: [35_00, 98_00],
  },
  {
    match: "BP ",
    category: "Fuel",
    description: "BP CONNECT",
    spend: [32_00, 95_00],
  },
  { match: "ESSO", category: "Fuel" },
  { match: "TEXACO", category: "Fuel" },
  { match: "GULF", category: "Fuel" },
  { match: "JET ", category: "Fuel" },
  { match: "MOTO ", category: "Fuel" },
  { match: "WELCOME BREAK", category: "Fuel" },

  // Transport
  {
    match: "TFL",
    category: "Transport",
    description: "TFL TRAVEL CHARGE",
    spend: [2_40, 28_60],
  },
  { match: "TRANSPORT FOR LONDON", category: "Transport" },
  {
    match: "TRAINLINE",
    category: "Transport",
    description: "TRAINLINE.COM",
    spend: [9_40, 186_00],
  },
  { match: "NATIONAL RAIL", category: "Transport" },
  { match: "LNER", category: "Transport" },
  { match: "GWR", category: "Transport" },
  { match: "AVANTI", category: "Transport" },
  { match: "NORTHERN RAIL", category: "Transport" },
  { match: "SCOTRAIL", category: "Transport" },
  { match: "STAGECOACH", category: "Transport" },
  { match: "FIRSTBUS", category: "Transport" },
  // Must not claim UBER EATS: two asserts on one transaction is a conflict.
  { match: "UBER(?!\\s*EATS)", category: "Transport" },
  { match: "BOLT\\.EU", category: "Transport" },
  { match: "ADDISON LEE", category: "Transport" },
  { match: "NCP", category: "Transport" },
  { match: "RINGGO", category: "Transport" },
  { match: "PARKING", category: "Transport" },

  // Utilities
  {
    match: "BRITISH GAS",
    category: "Utilities",
    description: "BRITISH GAS",
    spend: [48_00, 190_00],
  },
  {
    match: "EDF",
    category: "Utilities",
    description: "EDF ENERGY",
    spend: [45_00, 175_00],
  },
  { match: "E\\.?ON", category: "Utilities" },
  { match: "OCTOPUS( ENERGY)?", category: "Utilities" },
  { match: "SCOTTISH POWER", category: "Utilities" },
  { match: "SSE", category: "Utilities" },
  { match: "OVO ENERGY", category: "Utilities" },
  { match: "BULB", category: "Utilities" },
  { match: "SHELL ENERGY", category: "Utilities" },
  {
    match: "THAMES WATER",
    category: "Utilities",
    description: "THAMES WATER",
    spend: [22_00, 64_00],
  },
  { match: "ANGLIAN WATER", category: "Utilities" },
  { match: "SEVERN TRENT", category: "Utilities" },
  { match: "YORKSHIRE WATER", category: "Utilities" },
  { match: "UNITED UTILITIES", category: "Utilities" },
  { match: "SCOTTISH WATER", category: "Utilities" },
  { match: "WESSEX WATER", category: "Utilities" },

  // Home and garden
  {
    match: "B&Q",
    category: "Home & Garden",
    description: "B&Q LIMITED",
    spend: [8_00, 310_00],
  },
  {
    match: "SCREWFIX",
    category: "Home & Garden",
    description: "SCREWFIX DIRECT",
    spend: [7_50, 240_00],
  },
  { match: "WICKES", category: "Home & Garden" },
  { match: "HOMEBASE", category: "Home & Garden" },
  { match: "IKEA", category: "Home & Garden" },
  { match: "DUNELM", category: "Home & Garden" },
  { match: "TOOLSTATION", category: "Home & Garden" },

  // Phone and internet
  {
    match: "BT GROUP",
    category: "Phone & Internet",
    description: "BT GROUP PLC",
    spend: [28_00, 72_00],
  },
  { match: "BRITISH TELECOM", category: "Phone & Internet" },
  { match: "SKY DIGITAL", category: "Phone & Internet" },
  { match: "SKY UK", category: "Phone & Internet" },
  { match: "VIRGIN MEDIA", category: "Phone & Internet" },
  { match: "VODAFONE", category: "Phone & Internet" },
  { match: "EE (LTD|LIMITED)", category: "Phone & Internet" },
  { match: "O2 ", category: "Phone & Internet" },
  { match: "THREE UK", category: "Phone & Internet" },
  { match: "PLUSNET", category: "Phone & Internet" },
  { match: "TALKTALK", category: "Phone & Internet" },
  { match: "GIFFGAFF", category: "Phone & Internet" },

  // Subscriptions
  { match: "MICROSOFT", category: "Subscriptions" },
  {
    match: "NETFLIX",
    category: "Subscriptions",
    description: "NETFLIX.COM",
    spend: [10_99, 17_99],
  },
  {
    match: "SPOTIFY",
    category: "Subscriptions",
    description: "SPOTIFY UK",
    spend: [11_99, 19_99],
  },
  { match: "DISNEY", category: "Subscriptions" },
  { match: "APPLE\\.?COM\\/BILL", category: "Subscriptions" },
  { match: "PRIME VIDEO", category: "Subscriptions" },
  { match: "AUDIBLE", category: "Subscriptions" },
  { match: "PATREON", category: "Subscriptions" },
  { match: "NOW TV", category: "Subscriptions" },
  { match: "GOOGLE STORAGE", category: "Subscriptions" },
  { match: "DROPBOX", category: "Subscriptions" },
  { match: "ADOBE", category: "Subscriptions" },

  // Shopping
  {
    match: "AMAZON",
    category: "Shopping",
    description: "AMAZON.CO.UK",
    spend: [4_99, 260_00],
  },
  { match: "AMZN", category: "Shopping" },
  {
    match: "ARGOS",
    category: "Shopping",
    description: "ARGOS LTD",
    spend: [12_00, 420_00],
  },
  { match: "JOHN LEWIS", category: "Shopping" },
  { match: "NEXT RETAIL", category: "Shopping" },
  { match: "PRIMARK", category: "Shopping" },
  { match: "TK ?MAXX", category: "Shopping" },
  { match: "SPORTS DIRECT", category: "Shopping" },
  { match: "CURRYS", category: "Shopping" },
  { match: "ZARA", category: "Shopping" },
  { match: "H&M", category: "Shopping" },
  { match: "UNIQLO", category: "Shopping" },
  {
    match: "MARKS\\s*&?\\s*SPENCER",
    category: "Shopping",
    description: "MARKS&SPENCER PLC",
    spend: [4_50, 120_00],
  },

  // Health
  {
    match: "BOOTS",
    category: "Health",
    description: "BOOTS THE CHEMIST",
    spend: [2_99, 46_00],
  },
  { match: "SUPERDRUG", category: "Health" },
  { match: "LLOYDS PHARMACY", category: "Health" },
  { match: "SPECSAVERS", category: "Health" },
  { match: "VISION EXPRESS", category: "Health" },
  { match: "NHS", category: "Health" },

  // Fitness
  {
    match: "PUREGYM",
    category: "Fitness",
    description: "PUREGYM LTD",
    spend: [19_99, 34_99],
  },
  { match: "THE GYM", category: "Fitness" },
  { match: "DAVID LLOYD", category: "Fitness" },
  { match: "NUFFIELD HEALTH", category: "Fitness" },
  { match: "VIRGIN ACTIVE", category: "Fitness" },
  { match: "ANYTIME FITNESS", category: "Fitness" },

  // Insurance
  {
    match: "AVIVA",
    category: "Insurance",
    description: "AVIVA INSURANCE",
    spend: [18_50, 96_00],
  },
  { match: "DIRECT LINE", category: "Insurance" },
  { match: "ADMIRAL", category: "Insurance" },
  { match: "LV=", category: "Insurance" },
  { match: "CHURCHILL", category: "Insurance" },
  { match: "HASTINGS", category: "Insurance" },
  { match: "ESURE", category: "Insurance" },
  { match: "AXA", category: "Insurance" },
  { match: "LEGAL & GENERAL", category: "Insurance" },

  // Savings and investments
  { match: "VANGUARD", category: "Savings & Investments" },
  { match: "HARGREAVES", category: "Savings & Investments" },
  { match: "AJ BELL", category: "Savings & Investments" },
  { match: "NUTMEG", category: "Savings & Investments" },
  { match: "FREETRADE", category: "Savings & Investments" },
  { match: "MONEYBOX", category: "Savings & Investments" },
  { match: "WEALTHIFY", category: "Savings & Investments" },

  // Gifts and charity
  { match: "OXFAM", category: "Gifts & Charity" },
  { match: "CANCER RESEARCH", category: "Gifts & Charity" },
  { match: "BRITISH RED CROSS", category: "Gifts & Charity" },
  { match: "RSPCA", category: "Gifts & Charity" },
  { match: "NSPCC", category: "Gifts & Charity" },
  { match: "SHELTER", category: "Gifts & Charity" },
  { match: "JUSTGIVING", category: "Gifts & Charity" },
  { match: "MACMILLAN", category: "Gifts & Charity" },
];

/** The categories present, in the order they first appear. */
export function merchantCategories(): CategoryLabel[] {
  const seen: CategoryLabel[] = [];
  for (const m of MERCHANTS)
    if (!seen.includes(m.category)) seen.push(m.category);
  return seen;
}

/**
 * One alternation per category: `\b(A|B|C)\b`.
 *
 * A single pattern per category rather than one per merchant, because every
 * seeded rule asserts and two asserts on one transaction conflict. Merging by
 * category cannot produce that collision; a rule each would, the moment two
 * merchants shared a word.
 */
export function merchantPatternFor(category: CategoryLabel): string {
  const parts = MERCHANTS.filter((m) => m.category === category).map(
    (m) => m.match,
  );
  if (parts.length === 0)
    throw new Error(`no merchants for category ${category}`);
  return `\\b(${parts.join("|")})\\b`;
}

/** Those carrying enough detail to generate a transaction from. */
export function describableMerchants(): readonly (Merchant & {
  description: string;
  spend: readonly [number, number];
})[] {
  return MERCHANTS.filter(
    (
      m,
    ): m is Merchant & {
      description: string;
      spend: readonly [number, number];
    } => m.description !== undefined && m.spend !== undefined,
  );
}
