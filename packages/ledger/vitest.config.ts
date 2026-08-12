import { testConfig } from "@tightarse/vitest-config";

// Pinned to what this package covers today. Raise them; never lower them.
//
// Measured in CI, not locally. These integration tests run against DynamoDB
// Local there and against the real table here, and the two do not take
// identical paths — branches measured 81.2 on a developer machine and 79.03 in
// CI, which failed the build. CI is where the gate runs, so CI is the number.
export default testConfig({
  lines: 72.1,
  functions: 68.5,
  branches: 79.0,
  statements: 72.1,
});
