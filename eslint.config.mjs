import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * The architecture, as a check rather than a convention.
 *
 * Every claim this repository makes about its own layering was, until this file,
 * enforced by nothing. npm workspace manifests do not gate imports: every SDK is
 * hoisted to the root `node_modules` and every workspace is symlinked into
 * `node_modules/@tightarse/`, so Node's upward resolution finds all of them from
 * anywhere. `packages/domain` declares one dependency and can still
 * resolve both the S3 SDK and the ledger store. TypeScript project references
 * order the build and do not restrict resolution either — an import landing on a
 * built `.d.ts` is an error in neither case.
 *
 * So three things had already happened without a red build: two CLIs importing
 * an `@aws-sdk` package that was in no manifest, `services/ingest` referencing a
 * project it no longer used while not referencing one it did, and
 * `services/ingest` depending on `services/transform` because a Lambda entry
 * point had been filed there and a filing convention had become a layering
 * constraint.
 *
 * See #40. The layer lists below are the architectural statement; everything
 * else in this file is mechanism.
 */

const ROOT = import.meta.dirname;

/** Workspace directories, scanned rather than listed, so a new package is covered. */
function workspaceDirs() {
  const out = [];
  for (const group of ["packages", "services", "agents", "spike"]) {
    const dir = path.join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (existsSync(path.join(dir, name, "package.json"))) out.push(`${group}/${name}`);
    }
  }
  for (const solo of ["infra", "web"]) {
    if (existsSync(path.join(ROOT, solo, "package.json"))) out.push(solo);
  }
  return out;
}

const DIRS = workspaceDirs();
const nameOf = (dir) => JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")).name;

/**
 * Driving adapters: things the outside world starts. A Lambda entry point, a CLI,
 * a CDK app, a browser bundle.
 *
 * None of them may import another. They are siblings at the edge, and one
 * reaching into another is how `services/ingest` came to depend on
 * `services/transform`. Sharing between them belongs in a package.
 */
const DRIVERS = DIRS.filter((d) => /^(services|agents|spike)\//.test(d) || d === "infra" || d === "web");

/**
 * The domain model.
 *
 * `domain` is it. It was three packages — `ports`, `schema` and `categorisation`
 * — one naming the edges, one naming a shape without a subject, and one naming a
 * concept it shared with entities that lived elsewhere. They are now namespaces
 * inside a single package, grouped by what the code is about.
 *
 * `metrics` is here because it must not reach infrastructure, not because it is
 * domain: it formats CloudWatch's Embedded Metric Format and contains no domain
 * concept at all. The list restricts; it does not classify.
 *
 * The business logic still living in services and agents moves in behind these
 * names, one area at a time. See #43.
 *
 * `truelayer` is NOT here. The clue is the name: a package named after a vendor
 * is a driven adapter, exactly as `aws` and `dynamodb` are. It holds an HTTP
 * client, that provider's OAuth shapes, its error taxonomy, its endpoint map and
 * its measured limits. What was domain in it — how much overlap a sync asks for,
 * and the floor — had one consumer and now lives beside it in `services/ingest`.
 *
 * It differs from the other two adapters in one respect: it implements no port,
 * so `services/ingest` still names `TrueLayerClient` concretely and builds the
 * provider's URLs itself. Classifying it correctly is the first step, not the
 * last.
 *
 * Deliberately a deny list of what they may not reach rather than an allow list
 * of what they may, because the failure being prevented is specific — a
 * `DynamoDBClient` inside `packages/domain`, or a `fetch` where a port
 * belongs — and an allow list would need editing for every ordinary addition.
 */
const DOMAIN = ["packages/domain", "packages/metrics"];

/**
 * Tooling. Not the domain model, and the domain may not import it.
 *
 * `api-contract` is the HTTP adapter's business: the wire spelling of a result, the
 * URL that serves it, and the OpenAPI generated from both. It is a promise to
 * clients already installed, which changes for different reasons than the
 * application's own vocabulary — so it depends on nothing here and nothing here
 * depends on it. The one place the two meet is `services/api/src/wire.ts`.
 *
 * `fixtures` is test data. It imitates the provider's wire format, quirks and all,
 * and nothing it produces ships.
 *
 * Both are still barred from infrastructure below: neither has any business
 * holding an SDK.
 */
const TOOLING = ["packages/api-contract", "packages/fixtures"];

const INFRASTRUCTURE = [
  "@aws-sdk/*",
  "@aws-sdk/**",
  "aws-cdk-lib",
  "aws-cdk-lib/*",
  "@tightarse/aws",
  "@tightarse/dynamodb",
  "@tightarse/truelayer",
];

/**
 * Files that legitimately reach for devDependencies. Not shipped, not bundled.
 *
 * A glob over each workspace's test directory, rather than a list of filename
 * patterns: tests now live in their own directory, so "not shipped" is a place
 * rather than a naming convention every new file has to remember to follow.
 *
 * Written without the literal glob, because a block comment containing one ends
 * at the slash inside it and leaves the rest as code.
 */
const NOT_SHIPPED = [
  "**/test/**",
  "**/*.config.ts",
  "**/*.config.mts",
  "**/*.config.mjs",
  "**/vitest.shared.ts",
  "**/test-table.ts",
  "**/create-test-table.ts",
  "**/test-setup.ts",
  // Generators, not shipped: openapi.ts is reached only from openapi-cli.ts and
  // its own test, via the `openapi` npm script. Nothing bundles it into a Lambda,
  // so zod-to-json-schema is correctly a devDependency.
  "**/openapi.ts",
  "**/openapi-cli.ts",
];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/cdk.out/**",
      "**/.stryker/**",
      "**/reports/**",
      "web/dist/**",
    ],
  },

  // Parser only. No type-aware linting: these rules are about which module a
  // file may name, which is answerable from the import statement alone, and
  // turning on the project service would cost a full typecheck to learn nothing.
  {
    files: ["**/*.{ts,tsx,mts,cts,mjs}"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "import-x": importX },
  },

  // 1. An import must be in the importing workspace's own manifest.
  //
  // Root is allowed as a second manifest because genuine repo-wide tooling
  // (typescript, @types/node, esbuild) is declared once there. That does not
  // weaken the case this exists for: no `@aws-sdk` package appears in the root
  // manifest either, so a hoisted SDK import is still an error.
  ...DIRS.map((dir) => ({
    files: [`${dir}/**/*.{ts,tsx,mts,cts}`],
    rules: {
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          packageDir: [ROOT, path.join(ROOT, dir)],
          devDependencies: NOT_SHIPPED,
          peerDependencies: false,
          optionalDependencies: false,
        },
      ],
    },
  })),

  // 2a. Tooling may not reach infrastructure either. It is not domain, but neither
  // a wire contract nor a fixture generator has any use for an SDK.
  {
    files: TOOLING.map((d) => `${d}/**/*.ts`),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: INFRASTRUCTURE, message: "Tooling has no business holding an SDK. See #40." },
            {
              group: DRIVERS.map(nameOf),
              message: "Dependencies point inward: nothing here may import a service, agent or app. See #40.",
            },
          ],
        },
      ],
    },
  },

  // 2b. The domain may not reach infrastructure, nor tooling.
  {
    files: DOMAIN.map((d) => `${d}/**/*.ts`),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: INFRASTRUCTURE,
              message:
                "This package is domain code. An SDK or a store adapter belongs behind a port in packages/domain, implemented in packages/aws or packages/dynamodb and injected by a composition root. See #40.",
            },
            {
              group: DRIVERS.map(nameOf),
              message:
                "A package may not import a service, agent or app. Dependencies point inward: drivers depend on packages, never the reverse. See #40.",
            },
            {
              group: TOOLING.map(nameOf),
              message:
                "The domain model is ports and schema. @tightarse/api-contract is a promise to installed clients and @tightarse/fixtures is test data — both belong to adapters, not to the vocabulary they describe. The wire contract meets the domain in services/api/src/wire.ts and nowhere else.",
            },
          ],
        },
      ],
    },
  },

  // 3. No driving adapter may import another driving adapter.
  ...DRIVERS.map((dir) => ({
    files: [`${dir}/**/*.{ts,tsx}`],
    ignores: [`${dir}/**/*.test.ts`, `${dir}/**/*.test.tsx`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DRIVERS.filter((d) => d !== dir).map(nameOf),
              message:
                "Driving adapters are siblings at the edge and must not import each other — that is how services/ingest came to depend on services/transform. Move the shared code into a package. See #40.",
            },
          ],
        },
      ],
    },
  })),

  // The dashboard's hooks. App.tsx already carries a reasoned
  // `react-hooks/exhaustive-deps` disable explaining why `completeFrom` is
  // excluded from a dependency array; without the plugin that directive names a
  // rule nothing runs, which is worse than not having written it.
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Tests may cross the driver boundary, and one does: services/api's sign
  // regression drives real mapTransaction output from @tightarse/transform
  // through the API's own aggregation, which is the point of the test — a fake
  // would not have caught the inverted card sign. Nothing here is deployed.
  {
    files: ["**/test/**"],
    rules: { "no-restricted-imports": "off" },
  },
];
