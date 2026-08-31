/**
 * Write the OpenAPI document to disk.
 *
 *   npm run openapi -w @tightarse/api-contract
 *
 * The file is checked in so a diff shows contract changes in review, and the
 * snapshot test fails if someone edits the generated file by hand or changes a
 * schema without regenerating.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderOpenApiDocument } from "./openapi.js";

// import.meta.url, because every package but the CDK app is ESM (ADR 2).
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");
writeFileSync(out, renderOpenApiDocument());
console.log(`wrote ${out}`);
