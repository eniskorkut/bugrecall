export type EmbeddingConfig = {
  embeddings_enabled: boolean;
  model: string;
  timeout_ms: number;
  max_batch: number;
};

function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (!input) return fallback;
  const value = input.trim().toLowerCase();
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return fallback;
}

function parseIntSafe(input: string | undefined, fallback: number, min: number, max: number): number {
  if (!input) return fallback;
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function getEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  return {
    embeddings_enabled: parseBool(env.BUGRECALL_EMBEDDINGS, true),
    model: env.BUGRECALL_EMBEDDING_MODEL?.trim() || "Xenova/all-MiniLM-L6-v2",
    timeout_ms: parseIntSafe(env.BUGRECALL_EMBEDDING_TIMEOUT_MS, 30_000, 5_000, 300_000),
    max_batch: parseIntSafe(env.BUGRECALL_MAX_VECTORIZATION_BATCH, 10, 1, 100),
  };
}
