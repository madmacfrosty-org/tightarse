/**
 * AWS adapters. One class per port, each implementing exactly one.
 *
 * Separate from `@tightarse/dynamodb` so a component that reads the raw zone does
 * not acquire a dependency on the ledger store, and vice versa.
 */

export { S3RawObjects, type S3RawObjectsOptions } from "./raw-objects.js";
export { AwsSecrets, type AwsSecretsOptions } from "./secrets.js";
export { SnsNotifications, type SnsNotificationsOptions } from "./notifications.js";
export { startExecution } from "./workflows.js";
