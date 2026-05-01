import { getEmbeddingClient } from "../engine/embedding/embeddingClient.js";
import { getVectorStoreStatus } from "../db/vector/lanceStore.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIdentityAndProfile,
  ensureStore,
  getMemoryDetail,
  getRecurringErrors,
  getVectorizationStatus,
  indexReadyMemories,
  listUserCorrections,
  searchProjectExperience,
  vectorizePendingMemories,
} from "../index.js";

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

async function loadAgentInstructionTemplates(cwd: string): Promise<{ minimal: string; full: string; monorepo: string }> {
  const readOrFallback = async (filePath: string, fallback: string): Promise<string> => {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return fallback;
    }
  };

  const minimal = await readOrFallback(
    path.join(cwd, "examples", "agent-instruction-minimal.md"),
    "Use Bugrecall for this project. Bootstrap first, search memory before patching, finalize only after verification.",
  );
  const full = await readOrFallback(
    path.join(cwd, "examples", "agent-instruction-full.md"),
    "Use Bugrecall as debug memory: bootstrap, ingest/observe errors, search before patching, finalize after verification.",
  );
  const monorepo = await readOrFallback(
    path.join(cwd, "examples", "agent-instruction-monorepo.md"),
    "Use workspace_path consistently for monorepo tasks.",
  );
  return { minimal, full, monorepo };
}

function resolveBugrecallPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../..");
  return candidate;
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
        summary: row.summary,
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
      const detail = await getMemoryDetail(cwd, { workspace_path: workspacePath, memory_id: id });
      if (!detail.ok) return { status: 404, body: detail };
      return {
        status: 200,
        body: {
          ...detail,
          record: {
            ...(detail.memory as Record<string, unknown>),
            symptoms: ((detail.memory as Record<string, unknown>).metadata as Record<string, unknown>)?.symptoms ?? null,
            root_cause: ((detail.memory as Record<string, unknown>).metadata as Record<string, unknown>)?.root_cause ?? null,
            fix_pattern: ((detail.memory as Record<string, unknown>).metadata as Record<string, unknown>)?.fix_pattern ?? null,
            anti_patterns: ((detail.memory as Record<string, unknown>).metadata as Record<string, unknown>)?.anti_patterns ?? null,
            verification_steps:
              ((detail.memory as Record<string, unknown>).metadata as Record<string, unknown>)?.verification_steps ?? null,
          } as Record<string, unknown>,
        },
      };
    }

    if (pathname.startsWith("/api/memories/") && method === "DELETE") {
      const id = decodeURIComponent(pathname.replace("/api/memories/", ""));
      const deleted = store.deleteMemoryRecord(data.identity.project_id, id);
      if (!deleted.deleted) return { status: 404, body: { ok: false, reason: deleted.reason ?? "not_found" } };
      return { status: 200, body: { ok: true, deleted: true, memory_id: id } };
    }

    if (pathname === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return { status: 400, body: { ok: false, reason: "missing_query" } };
      const mode = parseMode(url.searchParams.get("mode"));
      const limit = parseLimit(url.searchParams.get("limit"), 10, 1, 50);
      const detail_level = url.searchParams.get("detail_level") === "full" ? "full" : "summary";
      const include_warnings = url.searchParams.get("include_warnings") !== "false";
      const result = await searchProjectExperience(cwd, {
        query: q,
        mode,
        limit,
        filters: {},
        workspace_path: workspacePath,
        detail_level,
        include_warnings,
      });
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

    if (pathname.startsWith("/api/recurring-errors/") && method === "GET") {
      const id = decodeURIComponent(pathname.replace("/api/recurring-errors/", ""));
      const signature = store.getErrorSignatureDetail(data.identity.project_id, id);
      if (!signature) return { status: 404, body: { ok: false, reason: "not_found" } };
      const occurrences = store.listErrorOccurrences(data.identity.project_id, id, parseLimit(url.searchParams.get("limit"), 20, 1, 200));
      const linkedMemory = signature.linked_memory_id ? store.getMemoryRecordById(data.identity.project_id, signature.linked_memory_id) : null;
      return {
        status: 200,
        body: {
          ok: true,
          signature,
          linked_memory: linkedMemory
            ? { id: linkedMemory.id, type: linkedMemory.type, summary: linkedMemory.summary, status: linkedMemory.status }
            : null,
          occurrences: occurrences.map((row) => ({
            id: row.id,
            task_run_id: row.task_run_id,
            command_kind: row.command_kind,
            normalized_error: row.normalized_error_json,
            created_at: row.created_at,
          })),
        },
      };
    }

    if (pathname === "/api/user-corrections" && method === "GET") {
      const result = await listUserCorrections(cwd, {
        workspace_path: workspacePath,
        limit: parseLimit(url.searchParams.get("limit"), 50, 1, 500),
        correction_type: (url.searchParams.get("correction_type") as "rejected_fix" | "project_preference" | null) ?? undefined,
        language: url.searchParams.get("language") ?? undefined,
        framework: url.searchParams.get("framework") ?? undefined,
        toolchain: url.searchParams.get("toolchain") ?? undefined,
        error_class: url.searchParams.get("error_class") ?? undefined,
      });
      return { status: 200, body: result };
    }

    if (pathname.startsWith("/api/user-corrections/") && method === "DELETE") {
      const id = decodeURIComponent(pathname.replace("/api/user-corrections/", ""));
      const record = store.getMemoryRecordById(data.identity.project_id, id);
      if (!record) return { status: 404, body: { ok: false, reason: "not_found" } };
      if (record.type !== "rejected_fix" && record.type !== "project_preference") {
        return { status: 400, body: { ok: false, reason: "not_user_correction" } };
      }
      const deleted = store.deleteMemoryRecord(data.identity.project_id, id);
      if (!deleted.deleted) return { status: 404, body: { ok: false, reason: deleted.reason ?? "not_found" } };
      return { status: 200, body: { ok: true, deleted: true, memory_id: id } };
    }

    if (pathname === "/api/export" && method === "GET") {
      const memoryRows = store.listMemoryRecords(data.identity.project_id, {}, 500);
      const recurring = store.listRecurringErrors(data.identity.project_id, { limit: 200, min_occurrences: 1 });
      const corrections = store.listUserCorrections(data.identity.project_id, {}, 200);
      const tasks = store.listTaskRuns(data.identity.project_id, 200);
      const patches = store.listPatchHistory(data.identity.project_id, 200);
      return {
        status: 200,
        body: {
          ok: true,
          version: "bugrecall-export-v1",
          exported_at: new Date().toISOString(),
          project: {
            identity: data.identity,
            profile: data.profile,
          },
          memories: memoryRows.map((m) => ({
            id: m.id,
            type: m.type,
            scope: m.scope,
            summary: m.summary,
            content: m.content,
            metadata: m.metadata,
            status: m.status,
            confidence: m.confidence,
            created_at: m.created_at,
            updated_at: m.updated_at,
            retrieval_hits: m.retrieval_hits,
            last_retrieved_at: m.last_retrieved_at,
          })),
          recurring_errors: recurring.map((r) => ({
            id: r.id,
            signature_hash: r.signature_hash,
            error_class: r.error_class,
            language: r.language,
            toolchain: r.toolchain,
            normalized_message: r.normalized_message,
            occurrence_count: r.occurrence_count,
            first_seen_at: r.first_seen_at,
            last_seen_at: r.last_seen_at,
            linked_memory_id: r.linked_memory_id,
          })),
          user_corrections: corrections.map((c) => ({
            id: c.id,
            type: c.type,
            summary: c.summary,
            content: c.content,
            metadata: c.metadata,
            confidence: c.confidence,
            created_at: c.created_at,
          })),
          task_runs_summary: tasks.map((t) => ({
            id: t.id,
            task_text: t.task_text,
            status: t.status,
            started_at: t.started_at,
            ended_at: t.ended_at,
            summary: t.summary,
          })),
          patch_history_summary: patches.map((p) => ({
            id: p.id,
            task_run_id: p.task_run_id,
            file_path: p.file_path,
            success_flag: p.success_flag,
            reason: p.reason,
            created_at: p.created_at,
          })),
        },
      };
    }

    if (pathname === "/api/agent-instructions" && method === "GET") {
      const packageRoot = resolveBugrecallPackageRoot();
      const templates = await loadAgentInstructionTemplates(packageRoot);
      return { status: 200, body: { ok: true, templates } };
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
