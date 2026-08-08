/**
 * Deployment configuration.
 *
 * eu-west-1 (Ireland) rather than eu-west-2 (London): London supports only
 * AgentCore Gateway, Identity and Memory — not AgentCore Runtime, which is
 * what hosts the Strands agents. UK GDPR adequacy covers EU storage.
 */
export const config = {
  region: "eu-west-1",
  appName: "tightarse",
  /** Ingest cadence. Unattended open banking access is capped at 4 calls per
   *  24h per consent, so daily leaves plenty of headroom for manual refreshes. */
  ingestScheduleCron: { minute: "0", hour: "5" },
  /** Nudge for consent reconfirmation this many days after it was granted.
   *  Consent lapses at 90 days; 80 leaves time to act. */
  consentReconfirmNudgeDays: 80,
} as const;

export type Config = typeof config;
