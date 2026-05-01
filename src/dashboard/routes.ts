import { getEmbeddingClient } from "../engine/embedding/embeddingClient.js";
import { getVectorStoreStatus } from "../db/vector/lanceStore.js";
import { buildIdentityAndProfile, ensureStore, getRecurringErrors, getVectorizationStatus, indexReadyMemories, searchProjectExperience, vectorizePendingMemories } from "../index.js";

type ApiResult = {
  status: number;
  body: Record<string, unknown>;
};

function parseLimit(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseMode(value: string | null): "auto" | "text" | "vector" | "hybrid" {
  if (value === "text" || value === "vector" || value === "hybrid") return value;
  return "auto";
}

export async function handleApiRequest(cwd: string, method: string, pathname: string, url: URL, bodyRaw: string): Promise<ApiResult> {
  if (pathname === "/api/health" && method === "GET") {
    return { status: 200, body: { ok: true, service: "bugrecall-dashboard" } };
  }

  const workspacePath = url.searchParams.get("workspace_path") ?? undefined;
  const data = await buildIdentityAndProfile(cwd, workspacePath);
  const { store } = await ensureStore(data.agentRoot);
  try {
    if (pathname === "/api/project" && method === "GET") {
      return {
        status: 200,
        body: {
          ok: true,
          identity: data.identity,
          profile: data.profile,
        },
      };
    }

    if (pathname === "/api/overview" && method === "GET") {
      const counts = store.getMemoryCounts(data.identity.project_id);
      const v = await getVectorizationStatus(cwd, { workspace_path: workspacePath });
      const vectorStore = await getVectorStoreStatus();
      return {
        status: 200,
        body: {
          ok: true,
          project_id: data.identity.project_id,
          workspace_relative_path: data.identity.workspace_relative_path,
          languages: data.profile.languages,
          frameworks: data.profile.frameworks,
          package_manager: data.profile.package_manager,
          memory_counts: {
            pending_vectorization: counts.pending_vectorization ?? 0,
            ready: counts.ready ?? 0,
            failed: counts.failed ?? 0,
            pending_retry: counts.pending_retry ?? 0,
          },
          embedded_count: Number(v.embedded_count ?? 0),
          vector_search_enabled: Boolean(v.vector_search_enabled ?? false),
          vector_store_status: v.vector_store_status ?? vectorStore,
          worker_state: v.worker_state ?? getEmbeddingClient().getState(),
          task_run_count: store.countTaskRuns(data.identity.project_id),
          patch_count: store.countPatchHistory(data.identity.project_id),
        },
      };
    }

    if (pathname === "/api/memories" && method === "GET") {
      const filters = {
        type: url.searchParams.get("type") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        language: url.searchParams.get("language") ?? undefined,
        toolchain: url.searchParams.get("toolchain") ?? undefined,
        error_class: url.searchParams.get("error_class") ?? undefined,
      };
      const limit = parseLimit(url.searchParams.get("limit"), 100, 1, 500);
      const records = store.listMemoryRecords(data.identity.project_id, filters, limit).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        confidence: row.confidence,
        language: row.metadata.language ?? null,
        toolchain: row.metadata.toolchain ?? null,
        error_class: row.metadata.error_class ?? null,
        retrieval_hits: row.retrieval_hits,
        created_at: row.created_at,
      }));
      return { status: 200, body: { ok: true, count: records.length, records } };
    }

    if (pathname.startsWith("/api/memories/") && method === "GET") {
      const id = decodeURIComponent(pathname.replace("/api/memories/", ""));
      const record = store.getMemoryRecordById(data.identity.project_id, id);
      if (!record) return { status: 404, body: { ok: false, reason: "not_found" } };
      return {
        status: 200,
        body: {
          ok: true,
          record: {
            ...record,
            symptoms: record.metadata.symptoms ?? null,
            root_cause: record.metadata.root_cause ?? null,
            fix_pattern: record.metadata.fix_pattern ?? null,
            anti_patterns: record.metadata.anti_patterns ?? null,
            verification_steps: record.metadata.verification_steps ?? null,
          },
        },
      };
    }

    if (pathname === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return { status: 400, body: { ok: false, reason: "missing_query" } };
      const mode = parseMode(url.searchParams.get("mode"));
      const limit = parseLimit(url.searchParams.get("limit"), 10, 1, 50);
      const result = await searchProjectExperience(cwd, { query: q, mode, limit, filters: {}, workspace_path: workspacePath });
      return { status: 200, body: result };
    }

    if (pathname === "/api/vectorization/status" && method === "GET") {
      const result = await getVectorizationStatus(cwd, { workspace_path: workspacePath });
      return { status: 200, body: result };
    }

    if (pathname === "/api/recurring-errors" && method === "GET") {
      const result = await getRecurringErrors(cwd, {
        workspace_path: workspacePath,
        limit: parseLimit(url.searchParams.get("limit"), 20, 1, 200),
        min_occurrences: parseLimit(url.searchParams.get("min_occurrences"), 2, 1, 1000),
        language: url.searchParams.get("language") ?? undefined,
        toolchain: url.searchParams.get("toolchain") ?? undefined,
        error_class: url.searchParams.get("error_class") ?? undefined,
      });
      return { status: 200, body: result };
    }

    if (pathname === "/api/vectorization/run" && method === "POST") {
      const body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
      const limit = Math.max(1, Math.min(50, Number(body.limit ?? 10)));
      const retry_failed = Boolean(body.retry_failed ?? false);
      const result = await vectorizePendingMemories(cwd, { limit, retry_failed, workspace_path: workspacePath });
      return { status: 200, body: result };
    }

    if (pathname === "/api/index/run" && method === "POST") {
      const body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
      const limit = Math.max(1, Math.min(500, Number(body.limit ?? 50)));
      const rebuild = Boolean(body.rebuild ?? false);
      const result = await indexReadyMemories(cwd, { limit, rebuild, workspace_path: workspacePath });
      return { status: 200, body: result };
    }

    if (pathname === "/api/patch-history" && method === "GET") {
      const limit = parseLimit(url.searchParams.get("limit"), 200, 1, 500);
      const rows = store.listPatchHistory(data.identity.project_id, limit);
      return { status: 200, body: { ok: true, count: rows.length, rows } };
    }

    if (pathname === "/api/task-runs" && method === "GET") {
      const limit = parseLimit(url.searchParams.get("limit"), 100, 1, 500);
      const rows = store.listTaskRuns(data.identity.project_id, limit).map((row) => ({
        ...row,
        command_usage: store.getTaskRunCommandUsage(row.id),
      }));
      return { status: 200, body: { ok: true, count: rows.length, rows } };
    }

    if (pathname.startsWith("/api/task-runs/") && method === "GET") {
      const id = decodeURIComponent(pathname.replace("/api/task-runs/", ""));
      const row = store.getTaskRunById(id);
      if (!row || row.project_id !== data.identity.project_id) {
        return { status: 404, body: { ok: false, reason: "not_found" } };
      }
      const attempts = store.getTaskAttempts(id);
      return {
        status: 200,
        body: {
          ok: true,
          task_run: row,
          command_usage: store.getTaskRunCommandUsage(id),
          attempts,
        },
      };
    }

    return { status: 404, body: { ok: false, reason: "not_found" } };
  } finally {
    store.close();
  }
}
