import { describe, it, expect, vi } from "vitest";
import type { Candidate } from "@tightarse/domain";
import { bedrockClassifier } from "../src/classifier.js";
import { DEFAULT_MODEL } from "../src/bedrock.js";

/**
 * The model behind the domain's port.
 *
 * Thin, but not nothing: it supplies the attribution the domain writes onto
 * every enrichment, and that label is the difference between a row a rule can
 * reproduce for free and one that cost a call.
 */

const client = (send: (cmd: never) => Promise<unknown>) => ({ send: vi.fn(send) }) as never;

const answer = {
  output: { message: { content: [{ toolUse: { input: { results: [{ i: 0, category: "Groceries", confidence: 0.9 }] } } }] } },
  usage: { inputTokens: 120, outputTokens: 30 },
};

const candidate: Candidate = { dedupKey: "d1", description: "A MERCHANT", amount: -10_00, currency: "GBP" };

describe("the classifier port over Bedrock", () => {
  it("attributes answers to the model that gave them", async () => {
    // "categoriser" alone would not say which model, and re-running a
    // categorisation later needs to know what produced the last one.
    const c = bedrockClassifier(client(async () => answer), "some-model-id");
    expect(c.producedBy).toBe("categoriser@some-model-id");
  });

  it("falls back to the default model, and names that one too", async () => {
    const c = bedrockClassifier(client(async () => answer));
    expect(c.producedBy).toBe(`categoriser@${DEFAULT_MODEL}`);
  });

  it("asks the model it was configured with, not the default", async () => {
    // Getting this wrong bills a different model than the one attributed,
    // which would be invisible in the ledger and visible only on the invoice.
    const sent: Array<{ input: { modelId?: string } }> = [];
    const c = bedrockClassifier(
      client(async (cmd) => {
        sent.push(cmd as unknown as { input: { modelId?: string } });
        return answer;
      }),
      "some-model-id",
    );
    await c.classify([candidate]);
    expect(sent[0]?.input.modelId).toBe("some-model-id");
  });

  it("passes the batch through and returns what the model made of it", async () => {
    const c = bedrockClassifier(client(async () => answer), "some-model-id");
    const result = await c.classify([candidate]);
    expect(result.classifications).toEqual([{ dedupKey: "d1", category: "Groceries", confidence: 0.9 }]);
    expect(result).toMatchObject({ rejected: 0, missing: 0, inputTokens: 120, outputTokens: 30 });
  });
});
