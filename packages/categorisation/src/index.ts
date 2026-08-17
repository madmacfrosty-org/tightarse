/**
 * The categorisation domain. Pure — no AWS SDKs, no I/O, no model.
 *
 * Separate from `agents/categoriser` so the API can resolve a category without
 * pulling the Bedrock SDK into its bundle. That package becomes a driver — the
 * schedule, the batch, the model, the import CLI — and this one holds the
 * reasoning.
 *
 * See docs/design/categorisation.md.
 */

export * from "./provider.js";
export * from "./resolve.js";
