import type { SearchExperienceFilters, SearchExperienceResult, SqliteStore } from "../../db/sqlite/store.js";
import type { VectorSearchHit, VectorStoreStatus } from "../../db/vector/types.js";
import { searchVectors } from "../../db/vector/lanceStore.js";

type Mode = "auto" | "text" | "vector" | "hybrid";

type HybridParams = {
  projectRoot: string;
  projectId: string;
  query: string;
  filters: SearchExperienceFilters;
  limit: number;
  mode: Mode;
  queryVector?: number[] | null;
  store: SqliteStore;
};

type SearchResult = SearchExperienceResult & { reason: string };

export async function runHybridSearch(params: HybridParams): Promise<{
  mode_used: "text" | "vector" | "hybrid";
  vector_search_enabled: boolean;
  vector_store_status: VectorStoreStatus;
  results: SearchResult[];
  note?: string;
}> {
  const textResults = params.store.searchProjectExperience(params.projectId, params.query, params.filters, params.limit);
  const initialStatus: VectorStoreStatus = { state: "unavailable", enabled: false, reason: "vector not requested" };

  if (params.mode === "text") {
    return {
      mode_used: "text",
      vector_search_enabled: false,
      vector_store_status: initialStatus,
      results: textResults.map((r) => ({ ...r, reason: `text:${r.reason}` })),
    };
  }

  if (!params.queryVector || params.queryVector.length === 0) {
    if (params.mode === "vector") {
      return {
        mode_used: "vector",
        vector_search_enabled: false,
        vector_store_status: { state: "unavailable", enabled: false, reason: "query embedding unavailable" },
        results: [],
        note: "Vector mode requested but query embedding is unavailable",
      };
    }
    return {
      mode_used: "text",
      vector_search_enabled: false,
      vector_store_status: { state: "unavailable", enabled: false, reason: "query embedding unavailable" },
      results: textResults.map((r) => ({ ...r, reason: `text:${r.reason}` })),
      note: "Fell back to text search because query embedding is unavailable",
    };
  }

  const vector = await searchVectors(params.projectRoot, params.projectId, params.queryVector, params.filters, params.limit);
  const vectorEnabled = vector.status.state === "available";

  if (!vectorEnabled) {
    if (params.mode === "vector") {
      return {
        mode_used: "vector",
        vector_search_enabled: false,
        vector_store_status: vector.status,
        results: [],
        note: `Vector mode requested but unavailable: ${vector.reason ?? vector.status.reason ?? "unknown reason"}`,
      };
    }
    return {
      mode_used: "text",
      vector_search_enabled: false,
      vector_store_status: vector.status,
      results: textResults.map((r) => ({ ...r, reason: `text:${r.reason}` })),
      note: `Fell back to text search: ${vector.reason ?? vector.status.reason ?? "vector unavailable"}`,
    };
  }

  const vectorHydrated = hydrateVectorHits(params.store, params.projectId, vector.hits);
  if (params.mode === "vector") {
    const ranked = vectorHydrated.sort(byScoreCreated).slice(0, params.limit);
    params.store.markRecordsRetrieved(ranked.map((r) => r.id));
    return {
      mode_used: "vector",
      vector_search_enabled: true,
      vector_store_status: vector.status,
      results: ranked,
    };
  }

  const merged = mergeHybrid(vectorHydrated, textResults, params.limit);
  params.store.markRecordsRetrieved(merged.map((r) => r.id));
  return {
    mode_used: "hybrid",
    vector_search_enabled: true,
    vector_store_status: vector.status,
    results: merged,
  };
}

function hydrateVectorHits(store: SqliteStore, projectId: string, hits: VectorSearchHit[]): SearchResult[] {
  if (hits.length === 0) return [];
  const byId = new Map(hits.map((h) => [h.id, h]));
  const records = store.getMemoryRecordsByIds(projectId, hits.map((h) => h.id));
  return records.map((row) => {
    const hit = byId.get(row.id);
    const vectorScore = hit?.score ?? 0;
    return {
      id: row.id,
      type: row.type,
      scope: row.scope,
      content: row.content,
      metadata: row.metadata,
      confidence: row.confidence,
      status: row.status,
      created_at: row.created_at,
      retrieval_hits: row.retrieval_hits,
      score: vectorScore + row.confidence * 0.1,
      reason: "vector",
    };
  });
}

function mergeHybrid(vectorRows: SearchResult[], textRows: SearchExperienceResult[], limit: number): SearchResult[] {
  const map = new Map<string, SearchResult>();
  for (const row of textRows) {
    map.set(row.id, { ...row, reason: `text:${row.reason}` });
  }
  for (const row of vectorRows) {
    const existing = map.get(row.id);
    if (!existing) {
      map.set(row.id, row);
      continue;
    }
    const score = existing.score + row.score;
    map.set(row.id, {
      ...existing,
      score,
      reason: "hybrid",
    });
  }
  return Array.from(map.values()).sort(byScoreCreated).slice(0, limit);
}

function byScoreCreated(a: SearchResult, b: SearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return b.created_at.localeCompare(a.created_at);
}
