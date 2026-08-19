import { describe, it, expect, vi } from "vitest";
import { startExecution } from "./workflows";

const client = (send: (cmd: any) => Promise<unknown>) => ({ send: vi.fn(send) }) as any;

describe("starting a workflow", () => {
  it("passes the machine and serialises the input", async () => {
    const sent: any[] = [];
    await startExecution("arn:machine", "run-1", { connectionId: "c1" }, client(async (c) => {
      sent.push(c);
      return {};
    }));
    expect(sent[0].input).toEqual({
      stateMachineArn: "arn:machine",
      name: "run-1",
      input: '{"connectionId":"c1"}',
    });
  });

  it("truncates a name to the 80 characters Step Functions accepts", async () => {
    // A name that is too long is rejected at the API, which in the connect flow
    // means the sync never starts — and the deep-history window closes about an
    // hour after the authorisation, so it costs history no retry recovers.
    const sent: any[] = [];
    await startExecution("arn:machine", "c".repeat(200), {}, client(async (c) => {
      sent.push(c);
      return {};
    }));
    expect(sent[0].input.name).toHaveLength(80);
  });

  it("leaves a name that already fits alone", async () => {
    const sent: any[] = [];
    await startExecution("arn:machine", "short", {}, client(async (c) => {
      sent.push(c);
      return {};
    }));
    expect(sent[0].input.name).toBe("short");
  });

  // No test for the default client. On a class the default is built in the
  // constructor, so constructing exercises it; here it is a default parameter
  // that only evaluates on a real call, and the only way to reach it is to talk
  // to Step Functions. A test asserting `typeof startExecution === "function"`
  // would run none of it while reporting the line covered.
});
