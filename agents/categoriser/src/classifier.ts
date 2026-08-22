/**
 * The model, behind the domain's `Classifier` port.
 *
 * Thin on purpose: `classifyBatch` already returns exactly what the port asks
 * for. What this adds is the attribution — an enrichment records what produced
 * it, and the model id is the difference between a row that can be reproduced
 * for free by a rule and one that cost a call.
 */

import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Classifier } from "@tightarse/domain";
import { classifyBatch, DEFAULT_MODEL } from "./bedrock.js";

export function bedrockClassifier(client: BedrockRuntimeClient, modelId: string = DEFAULT_MODEL): Classifier {
  return {
    producedBy: `categoriser@${modelId}`,
    classify: (candidates) => classifyBatch(client, candidates, modelId),
  };
}
