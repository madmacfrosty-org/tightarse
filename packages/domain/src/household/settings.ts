/**
 * Household-wide decisions, where one person's choice applies to a shared ledger.
 */

import { z } from "zod";
import { Currency } from "../money.js";
import { EnrichmentMode } from "../categorisation/enrichment.js";
import { TenantId } from "./member.js";

export const TenantSettings = z.object({
  tenantId: TenantId,
  enrichment: EnrichmentMode,
  baseCurrency: Currency.default("GBP"),
  /**
   * How many days before a consent lapses to start saying so, and when to stop
   * being polite about it.
   *
   * Defaulted rather than required, as `baseCurrency` is, so every row written
   * before these existed reads without a migration.
   *
   * Thirty and ten rather than the alarm's ten alone. Renewal needs a person to
   * sit down with three banks, so a warning that arrives with ten days left is
   * a warning about next weekend. #69 makes the point that ten was inherited
   * rather than chosen.
   *
   * **Nothing can change these yet** — `putSettings` has no caller outside
   * tests, which is #151. Read through `getSettings` with a fallback anyway, so
   * the day a settings screen exists these are already what it writes.
   */
  consentWarnDays: z.number().int().positive().default(30),
  consentEscalateDays: z.number().int().positive().default(10),
  updatedAt: z.string().datetime(),
});
export type TenantSettings = z.infer<typeof TenantSettings>;

/**
 * Which household a person belongs to.
 *
 * Created by an administrator, never by the person signing in. With federated
 * login there is no password to gate on — anyone with a Google account could
 * reach the sign-in screen — so this record is what decides whether a verified
 * identity gets a household claim at all.
 *
 * No membership record means no claim, and no claim means the API refuses. It
 * fails closed by construction rather than by a check someone might remove.
 */
