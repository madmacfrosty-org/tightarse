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
import { join } from "node:path";
import { renderOpenApiDocument } from "./openapi.js";

// __dirname rather than import.meta.url: this package builds to CommonJS.
const out = join(__dirname, "..", "openapi.json");
writeFileSync(out, renderOpenApiDocument());
console.log(`wrote ${out}`);
