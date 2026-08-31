import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { ESLint } from "eslint";

/**
 * The lint rules that hold the architecture up, tested against code that breaks
 * them.
 *
 * Without this the config could pass vacuously. Every rule in `eslint.config.mjs`
 * is scoped by a `files` glob, and a glob that matches nothing produces a clean
 * run — the same clean run as a codebase with no violations. That failure mode is
 * exactly the one this repository keeps hitting: a check that reports success
 * because it examined nothing. `npm run lint` returning 0 is only evidence if
 * something can still make it return 1.
 *
 * Here rather than in a service because the rules are a statement about
 * @tightarse/domain — dependencies point inward, and this is what inward means.
 * See #40.
 */

/**
 * The repository root, found by walking up for the config itself.
 *
 * Not derived from `process.cwd()`: vitest's cwd depends on whether the suite was
 * started from the root or from this package, and a wrong root makes every
 * assertion below fail with "could not find config file" — which reads as a
 * broken test rather than as a broken lookup.
 */
function repoRoot(): string {
  let dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "eslint.config.mjs"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(
    "Could not locate eslint.config.mjs above " +
      path.dirname(fileURLToPath(import.meta.url)),
  );
}

const ROOT = repoRoot();
const eslint = new ESLint({ cwd: ROOT });

/** Rule ids reported for a hypothetical file at `filePath`. */
async function rulesFiring(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(ROOT, filePath),
    warnIgnored: false,
  });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "(fatal)");
}

describe("the domain cannot reach infrastructure", () => {
  it("refuses an AWS SDK inside a domain package", async () => {
    // The specific thing #40 proves is currently possible: packages/domain
    // declares only zod, and the S3 SDK still resolves from it via root hoisting.
    const firing = await rulesFiring(
      "packages/domain/src/leak.ts",
      'import { S3Client } from "@aws-sdk/client-s3";\nexport const c = S3Client;\n',
    );
    expect(firing).toContain("no-restricted-imports");
    // And separately, because it is in no manifest.
    expect(firing).toContain("import-x/no-extraneous-dependencies");
  });

  it("refuses the ledger store inside pure logic", async () => {
    // packages/domain holds the fold and must stay pure. Reaching
    // DynamoStore would make the evaluator untestable without a table, which is
    // the property the whole design was arranged to protect.
    const firing = await rulesFiring(
      "packages/domain/src/leak.ts",
      'import { DynamoStore } from "@tightarse/dynamodb";\nexport const s = DynamoStore;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("refuses a package importing a service, because dependencies point inward", async () => {
    const firing = await rulesFiring(
      "packages/domain/src/leak.ts",
      'import { route } from "@tightarse/http";\nexport const r = route;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("refuses the provider client inside the domain", async () => {
    // A package named after a vendor is an adapter. The domain talks to a bank
    // through a port, or it is not portable to a second one — and the sync-window
    // policy that used to live in that package is now beside its one consumer.
    const firing = await rulesFiring(
      "packages/domain/src/leak.ts",
      'import { TrueLayerClient } from "@tightarse/truelayer";\nexport const c = TrueLayerClient;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("allows an SDK in the adapter package, whose whole job is holding one", async () => {
    // The rule has to distinguish packages/aws from packages/domain. A blanket ban
    // would be enforced by deleting the adapters.
    const firing = await rulesFiring(
      "packages/aws/src/thing.ts",
      'import { S3Client } from "@aws-sdk/client-s3";\nexport const c = S3Client;\n',
    );
    expect(firing).toEqual([]);
  });
});

describe("the domain model is ports and schema", () => {
  it("refuses the wire contract inside the domain", async () => {
    // api-contract is a promise to clients already installed. The application's
    // own vocabulary must not be expressed in it, or a rename the contract cannot
    // afford becomes a rename the domain cannot make.
    const firing = await rulesFiring(
      "packages/domain/src/leak.ts",
      'import type { Summary } from "@tightarse/api-contract";\nexport type S = Summary;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("refuses test fixtures inside the domain", async () => {
    const firing = await rulesFiring(
      "packages/domain/src/leak.ts",
      'import { generateHousehold } from "@tightarse/truelayer";\nexport const g = generateHousehold;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("allows the HTTP adapter to hold both, because that is whose promise it is", async () => {
    // the http adapter's wire.ts is the one place the domain result and the wire
    // shape meet. Banning it there would mean the contract had no consumer.
    const firing = await rulesFiring(
      "packages/adapters/http/src/wire.ts",
      'import type { SummaryResponse } from "@tightarse/api-contract";\nexport type S = SummaryResponse;\n',
    );
    expect(firing).toEqual([]);
  });

  it("refuses an SDK inside tooling, which is not domain but still has no use for one", async () => {
    const firing = await rulesFiring(
      "packages/api-contract/src/leak.ts",
      'import { S3Client } from "@aws-sdk/client-s3";\nexport const c = S3Client;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });
});

describe("driving adapters cannot import each other", () => {
  it("refuses the dependency that actually happened", async () => {
    // the steps adapter depended on the events adapter because a Lambda entry point
    // had been filed there. Nothing failed. This is that build turning red.
    const firing = await rulesFiring(
      "packages/adapters/steps/src/steps.ts",
      'import { transformObject } from "@tightarse/events";\nexport const t = transformObject;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("refuses one inbound adapter reaching into another", async () => {
    const firing = await rulesFiring(
      "packages/adapters/schedule/src/thing.ts",
      'import { route } from "@tightarse/http";\nexport const r = route;\n',
    );
    expect(firing).toContain("no-restricted-imports");
  });

  it("allows a driver to import a package, which is the direction that is fine", async () => {
    const firing = await rulesFiring(
      "packages/adapters/steps/src/thing.ts",
      'import type { Secrets } from "@tightarse/domain";\nexport type S = Secrets;\n',
    );
    expect(firing).toEqual([]);
  });

  it("allows the one test that crosses the boundary on purpose", async () => {
    // the http adapter's sign regression drives real mapTransaction output through the
    // API's own aggregation. A fake would not have caught the inverted card sign,
    // and nothing here is deployed.
    //
    // The exemption is the test directory, not the filename: a helper sitting
    // beside the tests is no more shipped than the tests are.
    const firing = await rulesFiring(
      "packages/adapters/http/test/sign-regression.test.ts",
      'import { mapTransaction } from "@tightarse/events";\nexport const m = mapTransaction;\n',
    );
    expect(firing).toEqual([]);
  });
});

describe("undeclared dependencies", () => {
  it("refuses an import that is in no manifest, however well it resolves", async () => {
    // Two CLIs did exactly this with @aws-sdk/client-dynamodb and typechecked for
    // as long as nobody ran npm ci under a non-hoisting installer.
    const firing = await rulesFiring(
      "packages/adapters/steps/src/thing.ts",
      'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nexport const c = DynamoDBClient;\n',
    );
    expect(firing).toContain("import-x/no-extraneous-dependencies");
  });

  it("refuses a devDependency in code that ships", async () => {
    // A Lambda bundle is built from dependencies. Importing a devDependency from
    // src works locally and fails at runtime in the deployed function.
    const firing = await rulesFiring(
      "packages/adapters/http/src/thing.ts",
      'import { generateHousehold } from "@tightarse/truelayer";\nexport const g = generateHousehold;\n',
    );
    expect(firing).toContain("import-x/no-extraneous-dependencies");
  });

  it("allows that same devDependency from a test", async () => {
    const firing = await rulesFiring(
      "packages/adapters/http/test/thing.test.ts",
      'import { generateHousehold } from "@tightarse/truelayer";\nexport const g = generateHousehold;\n',
    );
    expect(firing).toEqual([]);
  });
});
