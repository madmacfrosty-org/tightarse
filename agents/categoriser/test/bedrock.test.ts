import { describe, it, expect, vi } from "vitest";
import type { Candidate } from "@tightarse/domain";
import { classifyBatch, DEFAULT_MODEL } from "../src/bedrock.js";

/**
 * The Bedrock adapter.
 *
 * Untested until now, on the one path in the system that costs money per call.
 * Tested against a fake client, exactly as the AWS adapters are — the request it
 * builds and the answer it makes of a response are both worth pinning, and
 * neither needs a model.
 */

const client = (send: (cmd: never) => Promise<unknown>) => ({ send: vi.fn(send) }) as never;

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  dedupKey: "d1",
  description: "A MERCHANT",
  amount: -10_00,
  currency: "GBP",
  ...over,
});

/**
 * The model answers by POSITION, not by dedup key.
 *
 * `{ results: [{ i, category, confidence }] }` — an index into the candidates it
 * was shown. Sending descriptions back would put a merchant name in the response
 * as well as the prompt; the index keeps the return trip free of it.
 */
const answer = (entries: Array<{ i: number; category: string; confidence: number }>) => ({
  output: { message: { content: [{ toolUse: { input: { results: entries } } }] } },
  usage: { inputTokens: 120, outputTokens: 30 },
});

describe("what it asks the model", () => {
  it("pins temperature to zero, so the same description gets the same category", async () => {
    // Re-categorisation churns the ledger for no reason otherwise, and the
    // history of a transaction's category stops meaning anything.
    const sent: Array<{ input: Record<string, unknown> }> = [];
    await classifyBatch(client(async (c) => { sent.push(c as never); return answer([]); }), [candidate()]);
    expect((sent[0]!.input as { inferenceConfig: { temperature: number } }).inferenceConfig.temperature).toBe(0);
  });

  it("forces the tool, so the answer is structured rather than prose", async () => {
    const sent: Array<{ input: Record<string, unknown> }> = [];
    await classifyBatch(client(async (c) => { sent.push(c as never); return answer([]); }), [candidate()]);
    const cfg = (sent[0]!.input as { toolConfig: { toolChoice: { tool: { name: string } } } }).toolConfig;
    expect(cfg.toolChoice.tool.name).toBe("record_categories");
  });

  it("uses the default model unless told otherwise", async () => {
    const sent: Array<{ input: Record<string, unknown> }> = [];
    const c = client(async (cmd) => { sent.push(cmd as never); return answer([]); });
    await classifyBatch(c, [candidate()]);
    await classifyBatch(c, [candidate()], "some.other.model");
    expect(sent[0]!.input["modelId"]).toBe(DEFAULT_MODEL);
    expect(sent[1]!.input["modelId"]).toBe("some.other.model");
  });
});

describe("what it makes of the answer", () => {
  it("returns the classifications the model chose", async () => {
    const res = await classifyBatch(
      client(async () => answer([{ i: 0, category: "Groceries", confidence: 0.9 }])),
      [candidate()],
    );
    expect(res.classifications).toEqual([{ dedupKey: "d1", category: "Groceries", confidence: 0.9 }]);
  });

  it("reports token usage, because this path costs money per call", async () => {
    const res = await classifyBatch(client(async () => answer([])), [candidate()]);
    expect(res).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });

  it("reports zero usage rather than NaN when the response omits it", async () => {
    // A missing usage block would otherwise propagate NaN into a cost metric,
    // and an alarm on NaN never fires.
    const res = await classifyBatch(
      client(async () => ({ output: { message: { content: [{ toolUse: { input: { results: [] } } }] } } })),
      [candidate()],
    );
    expect(res).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("treats a response with no tool use as nothing categorised", async () => {
    // The model answering in prose is a rejected response, not a crash, and the
    // transactions stay in the backlog for the next run.
    const res = await classifyBatch(
      client(async () => ({ output: { message: { content: [{ text: "I think it is groceries" }] } } })),
      [candidate()],
    );
    expect(res.classifications).toEqual([]);
    expect(res.missing).toBe(1);
  });
});
