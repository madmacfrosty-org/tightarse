import type { Category } from "./taxonomy.js";
import type { Candidate, Classification } from "./categorise.js";

/**
 * Deterministic merchant rules, applied before any model call.
 *
 * Two things this buys that a model cannot:
 *
 *   - Stability. Your everyday merchants get the same category for ever,
 *     rather than shifting when a model version changes underneath you.
 *   - Privacy. A matched transaction's description never leaves the account.
 *
 * It is NOT a cost measure. A full 9,653-transaction run costs about 80p, so
 * halving the token count saves pennies. Anyone maintaining this should weigh
 * new rules on determinism and data egress, not on spend.
 *
 * These patterns are deliberately GENERIC UK merchants — common chains that
 * apply to anyone. This repository is public, so a rules list curated from one
 * household's actual statements would publish where that household shops.
 * Private overrides belong outside the repo.
 */

export interface Rule {
  readonly pattern: RegExp;
  readonly category: Category;
}

export const RULES: readonly Rule[] = [
  // Groceries
  { pattern: /\b(TESCO|SAINSBURY|ASDA|ALDI|LIDL|MORRISONS|WAITROSE|CO-?OP|ICELAND|OCADO|BOOKER)\b/i, category: "Groceries" },
  { pattern: /\bM&?S\s*(SIMPLY\s*)?FOOD\b/i, category: "Groceries" },

  // Eating out
  { pattern: /\b(COSTA|STARBUCKS|CAFFE NERO|GREGGS|PRET|SUBWAY|NANDOS|WAGAMAMA|PIZZA (EXPRESS|HUT)|DOMINOS|MCDONALDS|KFC|BURGER KING)\b/i, category: "Eating Out" },
  { pattern: /\b(DELIVEROO|JUST\s*EAT|UBER\s*EATS)\b/i, category: "Eating Out" },

  // Fuel and transport
  { pattern: /\b(SHELL|BP |ESSO|TEXACO|GULF|JET |MOTO |WELCOME BREAK)\b/i, category: "Fuel" },
  { pattern: /\b(TFL|TRANSPORT FOR LONDON|TRAINLINE|NATIONAL RAIL|LNER|GWR|AVANTI|NORTHERN RAIL|SCOTRAIL|STAGECOACH|FIRSTBUS)\b/i, category: "Transport" },
  { pattern: /\b(UBER(?!\s*EATS)|BOLT\.EU|ADDISON LEE|NCP|RINGGO|PARKING)\b/i, category: "Transport" },

  // Utilities and home
  { pattern: /\b(BRITISH GAS|EDF|E\.?ON|OCTOPUS ENERGY|SCOTTISH POWER|SSE|OVO ENERGY|BULB|SHELL ENERGY)\b/i, category: "Utilities" },
  { pattern: /\b(THAMES WATER|ANGLIAN WATER|SEVERN TRENT|YORKSHIRE WATER|UNITED UTILITIES|SCOTTISH WATER|WESSEX WATER)\b/i, category: "Utilities" },
  { pattern: /\bCOUNCIL\b.*\bTAX\b|\bCOUNCIL TAX\b/i, category: "Council Tax" },
  { pattern: /\b(B&Q|SCREWFIX|WICKES|HOMEBASE|IKEA|DUNELM|TOOLSTATION)\b/i, category: "Home & Garden" },

  // Comms and subscriptions
  { pattern: /\b(BT GROUP|BRITISH TELECOM|SKY DIGITAL|SKY UK|VIRGIN MEDIA|VODAFONE|EE LTD|O2 |THREE UK|PLUSNET|TALKTALK|GIFFGAFF)\b/i, category: "Phone & Internet" },
  { pattern: /\b(NETFLIX|SPOTIFY|DISNEY|APPLE\.?COM\/BILL|PRIME VIDEO|AUDIBLE|PATREON|NOW TV|GOOGLE STORAGE|DROPBOX|ADOBE)\b/i, category: "Subscriptions" },

  // Shopping and health
  { pattern: /\b(AMAZON|AMZN)\b/i, category: "Shopping" },
  { pattern: /\b(ARGOS|JOHN LEWIS|NEXT RETAIL|PRIMARK|TK ?MAXX|SPORTS DIRECT|CURRYS|ZARA|H&M|UNIQLO)\b/i, category: "Shopping" },
  { pattern: /\b(BOOTS|SUPERDRUG|LLOYDS PHARMACY|SPECSAVERS|VISION EXPRESS|NHS)\b/i, category: "Health" },
  { pattern: /\b(PUREGYM|THE GYM|DAVID LLOYD|NUFFIELD HEALTH|VIRGIN ACTIVE|ANYTIME FITNESS)\b/i, category: "Fitness" },

  // Insurance and finance
  { pattern: /\b(AVIVA|DIRECT LINE|ADMIRAL|LV=|CHURCHILL|HASTINGS|ESURE|AXA|LEGAL & GENERAL)\b/i, category: "Insurance" },
  { pattern: /\b(VANGUARD|HARGREAVES|AJ BELL|NUTMEG|FREETRADE|MONEYBOX|WEALTHIFY)\b/i, category: "Savings & Investments" },

  // Charity
  { pattern: /\b(OXFAM|CANCER RESEARCH|BRITISH RED CROSS|RSPCA|NSPCC|SHELTER|JUSTGIVING|MACMILLAN)\b/i, category: "Gifts & Charity" },
];

/**
 * Cash and bank charges are identified by the provider's own transaction type
 * rather than the description, which is far more reliable — an ATM withdrawal's
 * description is usually a location, not a merchant.
 */
const PROVIDER_CATEGORY_RULES: Readonly<Record<string, Category>> = {
  ATM: "Cash Withdrawal",
  INTEREST: "Fees & Charges",
};

export interface RuleResult {
  classifications: Classification[];
  /** Candidates no rule matched — the model's job, if enabled. */
  unmatched: Candidate[];
}

export function applyRules(candidates: readonly Candidate[]): RuleResult {
  const classifications: Classification[] = [];
  const unmatched: Candidate[] = [];

  for (const c of candidates) {
    const byProvider = c.providerCategory
      ? PROVIDER_CATEGORY_RULES[c.providerCategory]
      : undefined;
    if (byProvider) {
      classifications.push({ dedupKey: c.dedupKey, category: byProvider, confidence: 1 });
      continue;
    }

    const rule = RULES.find((r) => r.pattern.test(c.description));
    if (rule) {
      // Confidence 1: a rule is an assertion, not an estimate. If a rule is
      // wrong the rule should be fixed, not hedged.
      classifications.push({ dedupKey: c.dedupKey, category: rule.category, confidence: 1 });
      continue;
    }

    unmatched.push(c);
  }

  return { classifications, unmatched };
}

export const RULES_VERSION = "rules@v1";
