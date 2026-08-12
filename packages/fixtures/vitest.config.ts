import { testConfig } from "@tightarse/vitest-config";

// Pinned to what this package covers today. Raise them; never lower them.
export default testConfig({
  lines: 100.0,
  functions: 100.0,
  branches: 94.1,
  statements: 100.0,
});
