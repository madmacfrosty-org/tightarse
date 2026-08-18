import { describe, it, expect } from "vitest";
import * as aws from "./index";

describe("what the package exports", () => {
  it("exposes one adapter per port, and nothing else", () => {
    // Each implements exactly one port. Bundling them behind a single "AWS"
    // class would hand a component that reads the raw zone the ability to
    // publish alerts and read secrets.
    expect(Object.keys(aws).sort()).toEqual(["AwsSecrets", "S3RawObjects", "SnsNotifications"]);
  });
});
