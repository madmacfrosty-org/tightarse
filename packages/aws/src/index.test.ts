import { describe, it, expect } from "vitest";
import * as aws from "./index";

describe("what the package exports", () => {
  it("exposes one capability per export, and nothing else", () => {
    // Each export grants exactly one thing. Bundling them behind a single "AWS"
    // class would hand a component that reads the raw zone the ability to
    // publish alerts and read secrets.
    //
    // Three are classes implementing a port in @tightarse/ports. startExecution
    // is a function, because the seam it satisfies is itself a function — the
    // connect flow is handed `startSync(connectionId)` and never sees a state
    // machine. An interface, an options object and a constructor around one AWS
    // call would add three things and hide none.
    expect(Object.keys(aws).sort()).toEqual([
      "AwsSecrets",
      "S3RawObjects",
      "SnsNotifications",
      "startExecution",
    ]);
  });
});
