import { describe, it, expect } from "vitest";
import * as categorisation from "./index";

describe("what the package exports", () => {
  it("exposes the domain the drivers depend on", () => {
    // The API resolves a category on the read path and the categoriser applies
    // rules on the write path. Both import from here, and neither may pull in an
    // AWS SDK to do it — which is why this package exists separately from
    // agents/categoriser.
    expect(typeof categorisation.resolve).toBe("function");
    expect(typeof categorisation.providerCategorisation).toBe("function");
    expect(typeof categorisation.observationVersion).toBe("function");
    expect(categorisation.PROVIDER_SET).toBe("provider");
  });
});
