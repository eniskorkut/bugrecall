import { parentPort } from "node:worker_threads";
import type { EmbeddingError, EmbeddingJob, EmbeddingResult } from "../engine/embedding/types.js";

type Extractor = (text: string, options?: Record<string, unknown>) => Promise<unknown>;

let extractor: Extractor | null = null;
let loadedModel: string | null = null;

async function ensureExtractor(model: string): Promise<Extractor> {
  if (extractor && loadedModel === model) return extractor;
  console.error(`[embedder] model loading start: ${model}`);
  const transformers = (await import("@huggingface/transformers")) as unknown as {
    pipeline: (task: string, modelId: string) => Promise<Extractor>;
    env: { allowRemoteModels: boolean; allowLocalModels: boolean };
  };
  const { pipeline, env } = transformers;
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  extractor = await pipeline("feature-extraction", model);
  loadedModel = model;
  console.error(`[embedder] model ready: ${model}`);
  return extractor;
}

function toVectorArray(output: unknown): number[] {
  if (output && typeof output === "object" && "data" in (output as Record<string, unknown>)) {
    const data = (output as { data: ArrayLike<number> }).data;
    return Array.from(data);
  }
  if (Array.isArray(output)) {
    const arr = output as unknown[];
    if (arr.length > 0 && Array.isArray(arr[0])) {
      return (arr[0] as number[]).map((v) => Number(v));
    }
    return (arr as number[]).map((v) => Number(v));
  }
  throw new Error("Unsupported embedding output format");
}

parentPort?.on("message", async (job: EmbeddingJob) => {
  try {
    const runner = await ensureExtractor(job.model);
    const output = await runner(job.text, { pooling: "mean", normalize: true });
    const vector = toVectorArray(output);
    const result: EmbeddingResult = {
      request_id: job.request_id,
      record_id: job.record_id,
      model: job.model,
      dimension: vector.length,
      vector,
    };
    parentPort?.postMessage(result);
  } catch (error: unknown) {
    const payload: EmbeddingError = {
      request_id: job.request_id,
      record_id: job.record_id,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort?.postMessage(payload);
  }
});
