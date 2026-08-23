import type { CustomRule } from "../index.js";
import { isCategoryLabel, type CategoryLabel } from "./taxonomy.js";
import type { Candidate, Classification } from "./taxonomy.js";

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

/**
 * A compiled merchant rule: a description pattern and the category it implies.
 *
 * Distinct from `Rule` in ./rules.ts, which is #39's authored, versioned model
 * and is meant to replace this. Both exist while that changeover is unbuilt, and
 * they were both called `Rule` in different packages — which only worked because
 * nothing imported the two together.
 */
export interface MerchantRule {
  readonly pattern: RegExp;
  readonly category: CategoryLabel;
}

/**
 * The patterns a new household starts with.
 *
 * A SEED, not a source. Once `seed-cli` has run, `built-in` lives in the table
 * as a versioned set and is changed there — by proposal, measured against the
 * real ledger, and accepted. Editing this list afterwards changes what the NEXT
 * household starts with and nothing else.
 *
 * That is deliberate. Rules are data: narrowing a pattern that matched motorway
 * services when it meant fuel should not need a pull request and a deploy, and
 * once a change is versioned, dry-run, breadth-measured and diffed before and
 * after, the gate is the review.
 *
 * The risk is drift — someone "fixing" a pattern here that the table stopped
 * using months ago — which is why this says so rather than leaving it to be
 * discovered.
 */
export const RULES: readonly MerchantRule[] = [
  // Groceries
  { pattern: /\b(TESCO|SAINSBURY'?S?|ASDA|ALDI|LIDL|MORRISON'?S?|WAITROSE|CO-?OP|ICELAND|OCADO|BOOKER)\b/i, category: "Groceries" },
  { pattern: /\bM&?S\s*(SIMPLY\s*)?FOOD\b/i, category: "Groceries" },

  // Eating out
  { pattern: /\b(COSTA|STARBUCKS|CAFFE NERO|GREGGS|PRET|SUBWAY|NANDO'?S|WAGAMAMA|PIZZA (EXPRESS|HUT)|DOMINO'?S|MCDONALD'?S|KFC|BURGER KING)\b/i, category: "Eating Out" },
  { pattern: /\b(DELIVEROO|JUST\s*EAT|UBER\s*EATS)\b/i, category: "Eating Out" },

  // Fuel and transport
  { pattern: /\b(SHELL|BP |ESSO|TEXACO|GULF|JET |MOTO |WELCOME BREAK)\b/i, category: "Fuel" },
  { pattern: /\b(TFL|TRANSPORT FOR LONDON|TRAINLINE|NATIONAL RAIL|LNER|GWR|AVANTI|NORTHERN RAIL|SCOTRAIL|STAGECOACH|FIRSTBUS)\b/i, category: "Transport" },
  { pattern: /\b(UBER(?!\s*EATS)|BOLT\.EU|ADDISON LEE|NCP|RINGGO|PARKING)\b/i, category: "Transport" },

  // Utilities and home
  { pattern: /\b(BRITISH GAS|EDF|E\.?ON|OCTOPUS( ENERGY)?|SCOTTISH POWER|SSE|OVO ENERGY|BULB|SHELL ENERGY)\b/i, category: "Utilities" },
  { pattern: /\b(THAMES WATER|ANGLIAN WATER|SEVERN TRENT|YORKSHIRE WATER|UNITED UTILITIES|SCOTTISH WATER|WESSEX WATER)\b/i, category: "Utilities" },
  { pattern: /\bCOUNCIL\b.*\bTAX\b|\bCOUNCIL TAX\b/i, category: "Council Tax" },
  { pattern: /\b(B&Q|SCREWFIX|WICKES|HOMEBASE|IKEA|DUNELM|TOOLSTATION)\b/i, category: "Home & Garden" },

  // Comms and subscriptions
  { pattern: /\b(BT GROUP|BRITISH TELECOM|SKY DIGITAL|SKY UK|VIRGIN MEDIA|VODAFONE|EE (LTD|LIMITED)|O2 |THREE UK|PLUSNET|TALKTALK|GIFFGAFF)\b/i, category: "Phone & Internet" },
  { pattern: /\bMICROSOFT\b/i, category: "Subscriptions" },
  { pattern: /\b(NETFLIX|SPOTIFY|DISNEY|APPLE\.?COM\/BILL|PRIME VIDEO|AUDIBLE|PATREON|NOW TV|GOOGLE STORAGE|DROPBOX|ADOBE)\b/i, category: "Subscriptions" },

  // Shopping and health
  { pattern: /\b(AMAZON|AMZN)\b/i, category: "Shopping" },
  { pattern: /\b(ARGOS|JOHN LEWIS|NEXT RETAIL|PRIMARK|TK ?MAXX|SPORTS DIRECT|CURRYS|ZARA|H&M|UNIQLO)\b/i, category: "Shopping" },
  { pattern: /\bMARKS\s*&?\s*SPENCER\b/i, category: "Shopping" },
  { pattern: /\b(BOOTS|SUPERDRUG|LLOYDS PHARMACY|SPECSAVERS|VISION EXPRESS|NHS)\b/i, category: "Health" },
  { pattern: /\b(PUREGYM|THE GYM|DAVID LLOYD|NUFFIELD HEALTH|VIRGIN ACTIVE|ANYTIME FITNESS)\b/i, category: "Fitness" },

  // Insurance and finance
  { pattern: /\b(AVIVA|DIRECT LINE|ADMIRAL|LV=|CHURCHILL|HASTINGS|ESURE|AXA|LEGAL & GENERAL)\b/i, category: "Insurance" },
  { pattern: /\b(VANGUARD|HARGREAVES|AJ BELL|NUTMEG|FREETRADE|MONEYBOX|WEALTHIFY)\b/i, category: "Savings & Investments" },

  // Bank charges, by their standard wording rather than a merchant name.
  { pattern: /\bNON[- ]STERLING (TRANSACTION )?FEE\b/i, category: "Fees & Charges" },
  { pattern: /\b(OVERDRAFT|UNARRANGED) (FEE|INTEREST|CHARGE)\b/i, category: "Fees & Charges" },

  // Paying a card off is money moving between your own accounts, not spending.
  // Named issuers only — a rule broad enough to catch "CARD PAYMENT" would
  // swallow ordinary purchases.
  { pattern: /\b(AMERICAN EXPRESS|AMEX)\b/i, category: "Transfer" },
  { pattern: /\bPAYMENT RECEIVED\b.*\bTHANK YOU\b/i, category: "Transfer" },

  // Charity
  { pattern: /\b(OXFAM|CANCER RESEARCH|BRITISH RED CROSS|RSPCA|NSPCC|SHELTER|JUSTGIVING|MACMILLAN)\b/i, category: "Gifts & Charity" },
];

/**
 * Cash and bank charges are identified by the provider's own transaction type
 * rather than the description, which is far more reliable — an ATM withdrawal's
 * description is usually a location, not a merchant.
 */
export const PROVIDER_RULES: Readonly<Record<string, CategoryLabel>> = {
  ATM: "Cash Withdrawal",
};


/**
 * Compile a household's own rules, skipping any that are unusable.
 *
 * A bad regex or an unknown category is dropped with a warning rather than
 * throwing: these are entered by hand, and one typo should not stop a whole
 * categorisation run.
 */
export function compileCustom(rules: readonly CustomRule[]): MerchantRule[] {
  const compiled: MerchantRule[] = [];
  for (const r of rules) {
    if (!isCategoryLabel(r.category)) {
      console.warn(`skipping custom rule "${r.pattern}": unknown category "${r.category}"`);
      continue;
    }
    try {
      compiled.push({ pattern: new RegExp(r.pattern, "i"), category: r.category });
    } catch {
      console.warn(`skipping custom rule "${r.pattern}": not a valid regular expression`);
    }
  }
  return compiled;
}
