import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { buildPrompt, parseResponse, SYSTEM_PROMPT } from "./categorise.js";
import { CATEGORIES, type Candidate, type Classification } from "@tightarse/domain";

/**
 * Bedrock inference.
 *
 * Haiku rather than a larger model: this is closed-set classification over short
 * strings, not reasoning. The EU inference profile keeps the data in-region,
 * which matters because the payload is bank transaction descriptions.
 */
export const DEFAULT_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Structured output via forced tool use rather than "please reply with JSON".
 * The model cannot then return prose, a code fence or an apology, so parsing
 * failures stop being a category of bug.
 */
const OUTPUT_TOOL: Tool = {
  toolSpec: {
    name: "record_categories",
    description: "Record the category for every transaction given.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                i: { type: "integer", description: "The transaction's index as given" },
                category: { type: "string", enum: [...CATEGORIES] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["i", "category", "confidence"],
            },
          },
        },
        required: ["results"],
      },
    },
  },
};

export interface InferenceResult {
  classifications: Classification[];
  rejected: number;
  missing: number;
  inputTokens: number;
  outputTokens: number;
}

export async function classifyBatch(
  client: BedrockRuntimeClient,
  candidates: readonly Candidate[],
  modelId = DEFAULT_MODEL,
): Promise<InferenceResult> {
  const res = await client.send(
    new ConverseCommand({
      modelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: [{ text: buildPrompt(candidates) }] }],
      toolConfig: {
        tools: [OUTPUT_TOOL],
        toolChoice: { tool: { name: "record_categories" } },
      },
      // Deterministic: the same description should get the same category on
      // every run, or re-categorisation would churn the ledger for no reason.
      inferenceConfig: { temperature: 0, maxTokens: 8192 },
    }),
  );

  const toolUse = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  const parsed = parseResponse(candidates, toolUse?.input ?? null);

  return {
    ...parsed,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
  };
}
