import { describe, it, expect } from "vitest";
import { templates } from "./harness";

/**
 * Account limits, checked across every stack at once.
 *
 * These are the failures that synthesise perfectly, pass every other test, and
 * are rejected by CloudFormation at deploy — after the merge, with the stack
 * rolled back. A limit is a property of the account, not of a stack, so
 * checking it per stack means the next new resource in whichever file had no
 * guard repeats the same failure.
 *
 * That is not hypothetical. The memory quota below was already learned once and
 * written down as a test in `ingest-stack.test.ts`; a Lambda later added to the
 * API stack, where no such test existed, was rejected at deploy for the exact
 * same reason. This file is that lesson kept somewhere it covers everything.
 */

const { foundation, data, api, ingest, web } = templates();
const ALL = { foundation, data, api, ingest, web };

/** The account default. Not raised, and nothing here needs it raised. */
const MEMORY_CEILING = 512;

describe("lambda memory", () => {
  it.each(Object.keys(ALL))("stays within the account quota in %s", (name) => {
    const fns = Object.entries(ALL[name as keyof typeof ALL].findResources("AWS::Lambda::Function"));
    for (const [id, fn] of fns) {
      const memory = (fn as { Properties?: { MemorySize?: number } }).Properties?.MemorySize;
      if (memory === undefined) continue;
      expect(memory, `${name}/${id} asks for ${memory}MB`).toBeLessThanOrEqual(MEMORY_CEILING);
    }
  });

  it("actually looks at some functions, so passing means something", () => {
    // A check that iterates nothing passes for ever. This is the assertion that
    // fails if the resource type is renamed or the harness stops synthesising.
    const total = Object.values(ALL).reduce(
      (n, t) => n + Object.keys(t.findResources("AWS::Lambda::Function")).length,
      0,
    );
    expect(total).toBeGreaterThan(5);
  });
});
