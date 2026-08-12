import { testConfig } from "@tightarse/vitest-config";

// Pinned to what this package covers today. Raise them; never lower them.
export default testConfig({
  lines: 96.5,
  functions: 50.0,
  branches: 66.6,
  statements: 96.5,
});
