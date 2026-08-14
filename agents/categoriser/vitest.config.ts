import { testConfig } from "@tightarse/vitest-config";

// Pinned to what this package covers today. Raise them; never lower them.
export default testConfig({
  lines: 30.2,
  functions: 38.4,
  branches: 83.7,
  statements: 30.2,
});
