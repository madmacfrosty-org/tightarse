/**
 * Where an integration test is allowed to point.
 *
 * This is a decision, not plumbing, so it lives apart from the script that
 * acts on it and is tested directly.
 *
 * The hazard is specific. The integration suites deliberately do not clean up
 * after themselves — the store is meant to be thrown away — so a run aimed at a
 * table that outlives it leaves rows behind, and the one table in this account
 * that must never receive them holds five years of real transactions that cost
 * a bank consent to acquire.
 *
 * Before this existed the defaults were `Ledger` in `eu-west-1`: the live
 * table's name, in the live region. Run with ambient credentials and nothing
 * set, the create script found the real ledger, reported "already exists", and
 * exited successfully.
 */

/** Real DynamoDB is only ever addressed in the region that holds no real data. */
export const CITEST_REGION = "eu-west-2";

/** The only table names an integration test may create, use or destroy. */
export const CITEST_TABLE_PREFIX = "tightarse-citest-";

export interface TestTarget {
  readonly tableName: string;
  readonly region: string;
  /** Set for DynamoDB Local, absent for real DynamoDB. */
  readonly endpoint?: string;
}

export interface TargetEnv {
  readonly LEDGER_TEST_TABLE?: string | undefined;
  readonly LEDGER_TEST_ENDPOINT?: string | undefined;
  readonly AWS_REGION?: string | undefined;
}

/**
 * Resolve a target, or throw explaining which rule was broken.
 *
 * There is no default table name. A default is what made the old script
 * dangerous: the safe path required knowing to set something, and the unsafe
 * path was what happened if you did not.
 *
 * An endpoint means the emulator, which holds nothing and can be named
 * anything. Without one this is real DynamoDB, and both restrictions apply —
 * region alone would still permit a table called `Ledger` in eu-west-2, which
 * is exactly what a copy-pasted command would create.
 */
export function resolveTestTarget(env: TargetEnv): TestTarget {
  const tableName = env.LEDGER_TEST_TABLE;
  if (!tableName) {
    throw new Error(
      "LEDGER_TEST_TABLE is not set. There is no default: the previous one was " +
        "the live table's name. Set it explicitly.",
    );
  }

  const endpoint = env.LEDGER_TEST_ENDPOINT;
  if (endpoint) {
    return { tableName, region: env.AWS_REGION ?? CITEST_REGION, endpoint };
  }

  if (!tableName.startsWith(CITEST_TABLE_PREFIX)) {
    throw new Error(
      `Refusing to touch ${tableName} on real DynamoDB. Integration tests may only ` +
        `use tables named ${CITEST_TABLE_PREFIX}*, which is also all the CI ` +
        `credential is permitted to reach.`,
    );
  }

  const region = env.AWS_REGION ?? CITEST_REGION;
  if (region !== CITEST_REGION) {
    throw new Error(
      `Refusing to touch ${tableName} in ${region}. Integration tests run in ` +
        `${CITEST_REGION} only, because that is the region holding no real data.`,
    );
  }

  return { tableName, region };
}
