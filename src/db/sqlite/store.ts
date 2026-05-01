import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { runMigrations } from "./migrations.js";

export type ProjectIdentityRow = {
  project_id: string;
  git_remote_hash: string | null;
  initial_commit_hash: string | null;
  workspace_relative_path: string;
  manifest_fingerprint: string | null;
};

export type ProjectProfileRow = {
  languages: string[];
  frameworks: string[];
  package_manager: string | null;
  test_command: string | null;
  lint_command: string | null;
  build_command: string | null;
  typecheck_command: string | null;
  repo_root_detected?: boolean;
  workspace_root_relative_path?: string;
  workspace_manifest_files?: string[];
};

export type StructuredCommand = {
  cmd: string;
  args: string[];
  cwd: string;
  source: string;
};

export type CommitPostmortemInput = {
  type: "incident" | "fact" | "decision" | "rejected_fix" | "project_preference";
  scope: "workspace-only" | "project-only" | "repo-family";
  content: string;
  confidence: number;
  metadata: Record<string, unknown>;
  summary?: string;
};

export type MemoryRecord = {
  id: string;
  project_id: string;
  type: string;
  scope: string;
  content: string;
  summary: string;
  metadata: Record<string, unknown>;
  status: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_retrieved_at: string | null;
  retrieval_hits: number;
};

export type SearchExperienceFilters = {
  type?: "incident" | "fact" | "decision" | "rejected_fix" | "project_preference";
  workspace?: string;
  toolchain?: string;
  language?: string;
  framework?: string;
  error_class?: string;
  min_confidence?: number;
};

export type SearchExperienceResult = {
  id: string;
  type: string;
  scope: string;
  content: string;
  summary: string;
  metadata: Record<string, unknown>;
  confidence: number;
  status: string;
  score: number;
  reason: string;
  created_at: string;
  retrieval_hits: number;
};

export type VectorizationQueueItem = MemoryRecord & {
  content_hash: string;
  embedding_text: string;
};

export type VectorizationStatus = {
  pending_count: number;
  ready_count: number;
  failed_count: number;
  pending_retry_count: number;
  embedded_count: number;
};

export type EmbeddingCacheEntry = {
  record_id: string;
  project_id: string;
  model: string;
  dimension: number;
  content_hash: string;
};

export type SnapshotRow = {
  id: string;
  task_run_id: string;
  project_id: string | null;
  workspace_relative_path: string | null;
  file_path: string;
  content_blob: Buffer;
  compression: "gzip" | "brotli";
  created_at: string;
};

export type ReadyEmbeddingRow = {
  id: string;
  project_id: string;
  type: string;
  scope: string;
  metadata: Record<string, unknown>;
  model: string;
  dimension: number;
  vector: Float32Array;
};

export type TaskBudget = {
  max_total_command_runs: number;
  max_test_runs: number;
  max_lint_runs: number;
  max_build_runs: number;
  max_typecheck_runs: number;
  timeout_ms: number;
};

export type TaskRunRow = {
  id: string;
  project_id: string;
  session_id: string;
  task_text: string;
  status: string;
  approval_budget: TaskBudget;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
};

export type TaskAttemptRow = {
  id: string;
  task_run_id: string;
  project_id: string;
  kind: string;
  summary: string;
  success_flag: number;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type MemoryListFilters = {
  type?: string;
  status?: string;
  language?: string;
  toolchain?: string;
  error_class?: string;
};

export type UserCorrectionFilters = {
  correction_type?: "rejected_fix" | "project_preference";
  language?: string;
  framework?: string;
  toolchain?: string;
  error_class?: string;
};

export type ErrorSignatureUpsertInput = {
  project_id: string;
  workspace_relative_path: string;
  signature_hash: string;
  language: string | null;
  toolchain: string | null;
  error_class: string | null;
  normalized_message: string;
  top_frame_symbol: string | null;
  file_hint: string | null;
  command_kind: string | null;
  last_observation_json: Record<string, unknown>;
};

export type ErrorSignatureRow = {
  id: string;
  project_id: string;
  workspace_relative_path: string;
  signature_hash: string;
  language: string | null;
  toolchain: string | null;
  error_class: string | null;
  normalized_message: string;
  top_frame_symbol: string | null;
  file_hint: string | null;
  command_kind: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  linked_memory_id: string | null;
  last_observation_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ErrorOccurrenceRow = {
  id: string;
  signature_id: string;
  project_id: string;
  task_run_id: string | null;
  command_kind: string | null;
  normalized_error_json: Record<string, unknown>;
  raw_log_hash: string | null;
  created_at: string;
};

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  runMigrations(): string[] {
    return runMigrations(this.db);
  }

  upsertProject(identity: ProjectIdentityRow): void {
    this.db
      .prepare(
        `
      INSERT INTO projects (
        id, git_remote_hash, initial_commit_hash, workspace_relative_path, manifest_fingerprint, display_name
      ) VALUES (
        @project_id, @git_remote_hash, @initial_commit_hash, @workspace_relative_path, @manifest_fingerprint, @display_name
      )
      ON CONFLICT(id) DO UPDATE SET
        git_remote_hash = excluded.git_remote_hash,
        initial_commit_hash = excluded.initial_commit_hash,
        workspace_relative_path = excluded.workspace_relative_path,
        manifest_fingerprint = excluded.manifest_fingerprint,
        display_name = excluded.display_name,
        updated_at = CURRENT_TIMESTAMP
    `,
      )
      .run({
        ...identity,
        display_name: identity.workspace_relative_path,
      });
  }

  upsertProjectProfile(projectId: string, profile: ProjectProfileRow): void {
    this.db
      .prepare(
        `
      INSERT INTO project_profiles (
        project_id, languages_json, frameworks_json, package_manager, test_command_json,
        lint_command_json, build_command_json, typecheck_command_json, profile_version
      ) VALUES (
        @project_id, @languages_json, @frameworks_json, @package_manager, @test_command_json,
        @lint_command_json, @build_command_json, @typecheck_command_json, 1
      )
      ON CONFLICT(project_id) DO UPDATE SET
        languages_json = excluded.languages_json,
        frameworks_json = excluded.frameworks_json,
        package_manager = excluded.package_manager,
        test_command_json = excluded.test_command_json,
        lint_command_json = excluded.lint_command_json,
        build_command_json = excluded.build_command_json,
        typecheck_command_json = excluded.typecheck_command_json,
        updated_at = CURRENT_TIMESTAMP
    `,
      )
      .run({
        project_id: projectId,
        languages_json: JSON.stringify(profile.languages),
        frameworks_json: JSON.stringify(profile.frameworks),
        package_manager: profile.package_manager,
        test_command_json: profile.test_command ? JSON.stringify([profile.test_command]) : null,
        lint_command_json: profile.lint_command ? JSON.stringify([profile.lint_command]) : null,
        build_command_json: profile.build_command ? JSON.stringify([profile.build_command]) : null,
        typecheck_command_json: profile.typecheck_command ? JSON.stringify([profile.typecheck_command]) : null,
      });
  }

  insertMemoryRecord(projectId: string, input: CommitPostmortemInput): { id: string; status: string } {
    const id = randomUUID();
    const status = "pending_vectorization";
    const summary = buildMemorySummary(input.content, input.metadata, input.summary);

    this.db
      .prepare(
        `
      INSERT INTO memory_records (
        id, project_id, type, scope, content, summary, metadata_json, status, confidence
      ) VALUES (
        @id, @project_id, @type, @scope, @content, @summary, @metadata_json, @status, @confidence
      )
    `,
      )
      .run({
        id,
        project_id: projectId,
        type: input.type,
        scope: input.scope,
        content: input.content,
        summary,
        metadata_json: JSON.stringify(input.metadata),
        status,
        confidence: input.confidence,
      });

    return { id, status };
  }

  readProjectMemory(projectId: string, type: string | undefined, limit: number): MemoryRecord[] {
    const limitSafe = Math.max(1, Math.min(100, limit));
    let rows: Array<Record<string, unknown>>;

    if (type) {
      rows = this.db
        .prepare(
          `
        SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
        FROM memory_records
        WHERE project_id = ? AND type = ? AND confidence >= 0.7
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `,
        )
        .all(projectId, type, limitSafe) as Array<Record<string, unknown>>;
    } else {
      rows = this.db
        .prepare(
          `
        SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
        FROM memory_records
        WHERE project_id = ? AND confidence >= 0.7
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `,
        )
        .all(projectId, limitSafe) as Array<Record<string, unknown>>;
    }

    if (rows.length > 0) {
      const markRetrieved = this.db.prepare(
        "UPDATE memory_records SET retrieval_hits = retrieval_hits + 1, last_retrieved_at = CURRENT_TIMESTAMP WHERE id = ?",
      );
      const tx = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          markRetrieved.run(id);
        }
      });
      tx(rows.map((row) => String(row.id)));
    }

    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      content: String(row.content),
      summary: String(row.summary ?? ""),
      metadata: safeJsonParse(String(row.metadata_json), {}),
      status: String(row.status),
      confidence: Number(row.confidence),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
      retrieval_hits: Number(row.retrieval_hits ?? 0) + 1,
    }));
  }

  searchProjectExperience(
    projectId: string,
    query: string,
    filters: SearchExperienceFilters,
    limit: number,
    markRetrieved = true,
  ): SearchExperienceResult[] {
    const limitSafe = Math.max(1, Math.min(100, limit));
    const minConfidence = Math.max(0, Math.min(1, filters.min_confidence ?? 0));
    const rows = this.db
      .prepare(
        `
      SELECT id, type, scope, content, summary, metadata_json, confidence, status, created_at, retrieval_hits
      FROM memory_records
      WHERE project_id = ? AND confidence >= ?
      ORDER BY datetime(created_at) DESC
      LIMIT 500
    `,
      )
      .all(projectId, minConfidence) as Array<Record<string, unknown>>;

    const queryTokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1);

    const scored = rows
      .map((row) => {
        const metadata = safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {});
        const content = String(row.content);
        const text = `${content} ${JSON.stringify(metadata)}`.toLowerCase();
        const reasons: string[] = [];
        let score = 0;

        if (filters.error_class && metadata.error_class === filters.error_class) {
          score += 5;
          reasons.push("error_class");
        }
        if (filters.workspace && metadata.workspace === filters.workspace) {
          score += 3;
          reasons.push("workspace");
        }
        if (filters.toolchain && metadata.toolchain === filters.toolchain) {
          score += 3;
          reasons.push("toolchain");
        }
        if (filters.language && metadata.language === filters.language) {
          score += 2;
          reasons.push("language");
        }
        if (filters.framework && metadata.framework === filters.framework) {
          score += 2;
          reasons.push("framework");
        }
        if (filters.type && String(row.type) === filters.type) {
          score += 2;
          reasons.push("type");
        }

        for (const token of queryTokens) {
          if (text.includes(token)) {
            score += 1;
            reasons.push(`q:${token}`);
          }
        }

        score += Number(row.confidence ?? 0) * 0.5;

        return {
          id: String(row.id),
          type: String(row.type),
          scope: String(row.scope),
          content,
          summary: String(row.summary ?? ""),
          metadata,
          confidence: Number(row.confidence ?? 0),
          status: String(row.status),
          score,
          reason: reasons.length ? Array.from(new Set(reasons)).join(",") : "recent",
          created_at: String(row.created_at),
          retrieval_hits: Number(row.retrieval_hits ?? 0) + 1,
        };
      })
      .filter((row) => {
        if (filters.type && row.type !== filters.type) return false;
        if (filters.workspace && row.metadata.workspace !== filters.workspace) return false;
        if (filters.toolchain && row.metadata.toolchain !== filters.toolchain) return false;
        if (filters.language && row.metadata.language !== filters.language) return false;
        if (filters.framework && row.metadata.framework !== filters.framework) return false;
        if (filters.error_class && row.metadata.error_class !== filters.error_class) return false;
        if (queryTokens.length === 0) return true;
        return row.score > row.confidence * 0.5;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return b.created_at.localeCompare(a.created_at);
      })
      .slice(0, limitSafe);

    if (markRetrieved && scored.length > 0) this.markRecordsRetrieved(scored.map((row) => row.id));

    return scored;
  }

  listPendingVectorizationRecords(limit: number): MemoryRecord[] {
    const limitSafe = Math.max(1, Math.min(1000, limit));
    const rows = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE status = 'pending_vectorization'
      ORDER BY datetime(created_at) ASC
      LIMIT ?
    `,
      )
      .all(limitSafe) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      content: String(row.content),
      summary: String(row.summary ?? ""),
      metadata: safeJsonParse(String(row.metadata_json), {}),
      status: String(row.status),
      confidence: Number(row.confidence),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
      retrieval_hits: Number(row.retrieval_hits ?? 0),
    }));
  }

  listPendingVectorizationRecordsForProject(
    projectId: string,
    limit: number,
    retryFailed: boolean,
  ): VectorizationQueueItem[] {
    const limitSafe = Math.max(1, Math.min(1000, limit));
    const statuses = retryFailed ? ["pending_vectorization", "pending_retry", "failed"] : ["pending_vectorization"];
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE project_id = ? AND status IN (${placeholders})
      ORDER BY datetime(created_at) ASC
      LIMIT ?
    `,
      )
      .all(projectId, ...statuses, limitSafe) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const metadata = safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {});
      const content = String(row.content);
      const embeddingText = buildEmbeddingText(content, metadata);
      return {
        id: String(row.id),
        project_id: String(row.project_id),
        type: String(row.type),
        scope: String(row.scope),
        content,
        summary: String(row.summary ?? ""),
        metadata,
        status: String(row.status),
        confidence: Number(row.confidence),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
        retrieval_hits: Number(row.retrieval_hits ?? 0),
        embedding_text: embeddingText,
        content_hash: sha256(`${content}\n${normalizeMetadata(metadata)}\nmodel:Xenova/all-MiniLM-L6-v2`),
      };
    });
  }

  markVectorizationReady(id: string): void {
    this.db
      .prepare(
        "UPDATE memory_records SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(id);
  }

  markVectorizationFailed(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE memory_records SET status = 'failed', last_error = ?, retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(error, id);
  }

  markVectorizationPendingRetry(id: string): void {
    this.db
      .prepare("UPDATE memory_records SET status = 'pending_retry', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id);
  }

  resetFailedVectorizationRecords(projectId: string, limit: number): number {
    const limitSafe = Math.max(1, Math.min(1000, limit));
    const ids = this.db
      .prepare(
        `
      SELECT id FROM memory_records
      WHERE project_id = ? AND status = 'failed'
      ORDER BY datetime(updated_at) DESC
      LIMIT ?
    `,
      )
      .all(projectId, limitSafe) as Array<{ id: string }>;
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      "UPDATE memory_records SET status = 'pending_retry', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    );
    const tx = this.db.transaction((rows: Array<{ id: string }>) => {
      for (const row of rows) stmt.run(row.id);
    });
    tx(ids);
    return ids.length;
  }

  upsertEmbeddingCache(params: {
    record_id: string;
    project_id: string;
    model: string;
    dimension: number;
    vector: Float32Array;
    content_hash: string;
  }): void {
    const vectorBlob = Buffer.from(
      params.vector.buffer,
      params.vector.byteOffset,
      params.vector.byteLength,
    );
    this.db
      .prepare(
        `
      INSERT INTO embedding_cache (record_id, project_id, model, dimension, vector_blob, content_hash)
      VALUES (@record_id, @project_id, @model, @dimension, @vector_blob, @content_hash)
      ON CONFLICT(record_id) DO UPDATE SET
        project_id = excluded.project_id,
        model = excluded.model,
        dimension = excluded.dimension,
        vector_blob = excluded.vector_blob,
        content_hash = excluded.content_hash,
        created_at = CURRENT_TIMESTAMP
    `,
      )
      .run({
        ...params,
        vector_blob: vectorBlob,
      });
  }

  getVectorizationStatus(projectId: string): VectorizationStatus {
    const statusRows = this.db
      .prepare(
        `
      SELECT status, COUNT(*) as count
      FROM memory_records
      WHERE project_id = ?
      GROUP BY status
    `,
      )
      .all(projectId) as Array<{ status: string; count: number }>;
    const byStatus = new Map<string, number>(statusRows.map((r) => [r.status, Number(r.count)]));
    const embeddedRow = this.db
      .prepare("SELECT COUNT(*) as count FROM embedding_cache WHERE project_id = ?")
      .get(projectId) as { count: number } | undefined;
    return {
      pending_count: byStatus.get("pending_vectorization") ?? 0,
      ready_count: byStatus.get("ready") ?? 0,
      failed_count: byStatus.get("failed") ?? 0,
      pending_retry_count: byStatus.get("pending_retry") ?? 0,
      embedded_count: embeddedRow ? Number(embeddedRow.count) : 0,
    };
  }

  getEmbeddingCacheEntry(recordId: string): EmbeddingCacheEntry | null {
    const row = this.db
      .prepare(
        "SELECT record_id, project_id, model, dimension, content_hash FROM embedding_cache WHERE record_id = ?",
      )
      .get(recordId) as EmbeddingCacheEntry | undefined;
    return row ?? null;
  }

  insertPatchHistory(params: {
    task_run_id: string;
    project_id: string;
    file_path: string;
    search_block: string;
    replace_block: string;
    match_count: number;
    success_flag: number;
    reason: string;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO patch_history (
        id, task_run_id, project_id, file_path, search_block, replace_block, match_count, success_flag, reason
      ) VALUES (
        @id, @task_run_id, @project_id, @file_path, @search_block, @replace_block, @match_count, @success_flag, @reason
      )
    `,
      )
      .run({
        id,
        ...params,
      });
    return id;
  }

  insertSnapshot(params: {
    task_run_id: string;
    project_id: string;
    workspace_relative_path: string;
    file_path: string;
    content_blob: Buffer;
    compression: "gzip" | "brotli";
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO snapshots (
        id, task_run_id, project_id, workspace_relative_path, file_path, content_blob, compression
      ) VALUES (
        @id, @task_run_id, @project_id, @workspace_relative_path, @file_path, @content_blob, @compression
      )
    `,
      )
      .run({
        id,
        ...params,
      });
    return id;
  }

  getSnapshotById(id: string): SnapshotRow | null {
    const row = this.db
      .prepare(
        `
      SELECT id, task_run_id, project_id, workspace_relative_path, file_path, content_blob, compression, created_at
      FROM snapshots
      WHERE id = ?
    `,
      )
      .get(id) as SnapshotRow | undefined;
    return row ?? null;
  }

  getMemoryRecordsByIds(projectId: string, ids: string[]): MemoryRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE project_id = ? AND id IN (${placeholders})
    `,
      )
      .all(projectId, ...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      content: String(row.content),
      summary: String(row.summary ?? ""),
      metadata: safeJsonParse(String(row.metadata_json), {}),
      status: String(row.status),
      confidence: Number(row.confidence),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
      retrieval_hits: Number(row.retrieval_hits ?? 0),
    }));
  }

  markRecordsRetrieved(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE memory_records SET retrieval_hits = retrieval_hits + 1, last_retrieved_at = CURRENT_TIMESTAMP WHERE id = ?",
    );
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) stmt.run(id);
    });
    tx(ids);
  }

  listReadyRecordsWithEmbeddings(projectId: string, limit: number): ReadyEmbeddingRow[] {
    const limitSafe = Math.max(1, Math.min(1000, limit));
    const rows = this.db
      .prepare(
        `
      SELECT
        mr.id,
        mr.project_id,
        mr.type,
        mr.scope,
        mr.metadata_json,
        ec.model,
        ec.dimension,
        ec.vector_blob
      FROM memory_records mr
      INNER JOIN embedding_cache ec ON ec.record_id = mr.id
      WHERE mr.project_id = ? AND mr.status = 'ready'
      ORDER BY datetime(mr.updated_at) DESC
      LIMIT ?
    `,
      )
      .all(projectId, limitSafe) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      metadata: safeJsonParse(String(row.metadata_json), {}),
      model: String(row.model),
      dimension: Number(row.dimension),
      vector: bufferToFloat32(row.vector_blob as Buffer),
    }));
  }

  countIndexedReadyRecords(projectId: string): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as count
      FROM memory_records mr
      INNER JOIN embedding_cache ec ON ec.record_id = mr.id
      WHERE mr.project_id = ? AND mr.status = 'ready'
    `,
      )
      .get(projectId) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  startTaskRun(projectId: string, taskText: string, budget: TaskBudget, sessionId: string): TaskRunRow {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO task_runs (id, project_id, session_id, task_text, status, approval_budget_json)
      VALUES (@id, @project_id, @session_id, @task_text, 'running', @approval_budget_json)
    `,
      )
      .run({
        id,
        project_id: projectId,
        session_id: sessionId,
        task_text: taskText,
        approval_budget_json: JSON.stringify(budget),
      });
    const row = this.getTaskRunById(id);
    if (!row) throw new Error("failed_to_create_task_run");
    return row;
  }

  getTaskRunById(taskRunId: string): TaskRunRow | null {
    const row = this.db
      .prepare(
        `
      SELECT id, project_id, session_id, task_text, status, approval_budget_json, started_at, ended_at, summary
      FROM task_runs
      WHERE id = ?
    `,
      )
      .get(taskRunId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      session_id: String(row.session_id),
      task_text: String(row.task_text),
      status: String(row.status),
      approval_budget: safeJsonParse<TaskBudget>(String(row.approval_budget_json ?? "{}"), defaultTaskBudget()),
      started_at: String(row.started_at),
      ended_at: row.ended_at ? String(row.ended_at) : null,
      summary: row.summary ? String(row.summary) : null,
    };
  }

  updateTaskRunStatus(taskRunId: string, status: string, summary: string | null): void {
    this.db
      .prepare(
        `
      UPDATE task_runs
      SET status = ?, summary = ?, ended_at = CASE WHEN ? IN ('succeeded', 'failed') THEN CURRENT_TIMESTAMP ELSE ended_at END
      WHERE id = ?
    `,
      )
      .run(status, summary, status, taskRunId);
  }

  getTaskRunCommandUsage(taskRunId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `
      SELECT metadata_json
      FROM task_attempts
      WHERE task_run_id = ? AND kind = 'command'
    `,
      )
      .all(taskRunId) as Array<Record<string, unknown>>;
    const usage = {
      total: 0,
      test: 0,
      lint: 0,
      build: 0,
      typecheck: 0,
    };
    for (const row of rows) {
      usage.total += 1;
      const metadata = safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {});
      const kind = String(metadata.command_kind ?? "");
      if (kind === "test") usage.test += 1;
      if (kind === "lint") usage.lint += 1;
      if (kind === "build") usage.build += 1;
      if (kind === "typecheck") usage.typecheck += 1;
    }
    return usage;
  }

  insertTaskAttempt(params: {
    task_run_id: string;
    project_id: string;
    kind: "patch" | "command" | "reasoning" | "memory";
    summary: string;
    success: boolean;
    metadata: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO task_attempts (id, task_run_id, project_id, kind, summary, success_flag, metadata_json)
      VALUES (@id, @task_run_id, @project_id, @kind, @summary, @success_flag, @metadata_json)
    `,
      )
      .run({
        id,
        task_run_id: params.task_run_id,
        project_id: params.project_id,
        kind: params.kind,
        summary: params.summary,
        success_flag: params.success ? 1 : 0,
        metadata_json: JSON.stringify(params.metadata ?? {}),
      });
    return id;
  }

  getProjectCommandString(projectId: string, kind: "test" | "lint" | "build" | "typecheck"): string | null {
    const row = this.db
      .prepare(
        `
      SELECT test_command_json, lint_command_json, build_command_json, typecheck_command_json
      FROM project_profiles
      WHERE project_id = ?
    `,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const key =
      kind === "test"
        ? "test_command_json"
        : kind === "lint"
          ? "lint_command_json"
          : kind === "build"
            ? "build_command_json"
            : "typecheck_command_json";
    const raw = row[key];
    if (raw === null || raw === undefined) return null;
    const parsed = safeJsonParse<unknown>(String(raw), null);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    if (typeof parsed === "string") return parsed;
    return null;
  }

  getProjectProfileById(projectId: string): ProjectProfileRow | null {
    const row = this.db
      .prepare(
        `
      SELECT languages_json, frameworks_json, package_manager, test_command_json, lint_command_json, build_command_json, typecheck_command_json
      FROM project_profiles
      WHERE project_id = ?
    `,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const first = (value: unknown): string | null => {
      if (value === null || value === undefined) return null;
      const parsed = safeJsonParse<unknown>(String(value), null);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
      if (typeof parsed === "string") return parsed;
      return null;
    };
    return {
      languages: safeJsonParse<string[]>(String(row.languages_json ?? "[]"), []),
      frameworks: safeJsonParse<string[]>(String(row.frameworks_json ?? "[]"), []),
      package_manager: row.package_manager ? String(row.package_manager) : null,
      test_command: first(row.test_command_json),
      lint_command: first(row.lint_command_json),
      build_command: first(row.build_command_json),
      typecheck_command: first(row.typecheck_command_json),
    };
  }

  getMemoryCounts(projectId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `
      SELECT status, COUNT(*) as count
      FROM memory_records
      WHERE project_id = ?
      GROUP BY status
    `,
      )
      .all(projectId) as Array<{ status: string; count: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = Number(row.count);
    return out;
  }

  listMemoryRecords(projectId: string, filters: MemoryListFilters, limit: number): MemoryRecord[] {
    const limitSafe = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE project_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 2000
    `,
      )
      .all(projectId) as Array<Record<string, unknown>>;

    return rows
      .map((row) => ({
        id: String(row.id),
        project_id: String(row.project_id),
        type: String(row.type),
        scope: String(row.scope),
        content: String(row.content),
        summary: String(row.summary ?? ""),
        metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {}),
        status: String(row.status),
        confidence: Number(row.confidence),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
        retrieval_hits: Number(row.retrieval_hits ?? 0),
      }))
      .filter((row) => (filters.type ? row.type === filters.type : true))
      .filter((row) => (filters.status ? row.status === filters.status : true))
      .filter((row) => (filters.language ? String(row.metadata.language ?? "") === filters.language : true))
      .filter((row) => (filters.toolchain ? String(row.metadata.toolchain ?? "") === filters.toolchain : true))
      .filter((row) => (filters.error_class ? String(row.metadata.error_class ?? "") === filters.error_class : true))
      .slice(0, limitSafe);
  }

  getMemoryRecordById(projectId: string, id: string): MemoryRecord | null {
    const row = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE project_id = ? AND id = ?
    `,
      )
      .get(projectId, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      content: String(row.content),
      summary: String(row.summary ?? ""),
      metadata: safeJsonParse(String(row.metadata_json), {}),
      status: String(row.status),
      confidence: Number(row.confidence),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
      retrieval_hits: Number(row.retrieval_hits ?? 0),
    };
  }

  deleteMemoryRecord(projectId: string, id: string): { deleted: boolean; reason?: "not_found" } {
    const tx = this.db.transaction((project: string, memoryId: string) => {
      const existing = this.db
        .prepare("SELECT id FROM memory_records WHERE project_id = ? AND id = ?")
        .get(project, memoryId) as { id: string } | undefined;
      if (!existing) return { deleted: false as const, reason: "not_found" as const };

      this.db.prepare("DELETE FROM memory_records WHERE project_id = ? AND id = ?").run(project, memoryId);
      this.db
        .prepare("UPDATE error_signatures SET linked_memory_id = NULL, updated_at = ? WHERE project_id = ? AND linked_memory_id = ?")
        .run(new Date().toISOString(), project, memoryId);

      return { deleted: true as const };
    });

    return tx(projectId, id);
  }

  getMemoryRecordByIdAnyProject(id: string): MemoryRecord | null {
    const row = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE id = ?
    `,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      content: String(row.content),
      summary: String(row.summary ?? ""),
      metadata: safeJsonParse(String(row.metadata_json), {}),
      status: String(row.status),
      confidence: Number(row.confidence),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
      retrieval_hits: Number(row.retrieval_hits ?? 0),
    };
  }

  listPatchHistory(projectId: string, limit: number): Array<Record<string, unknown>> {
    const limitSafe = Math.max(1, Math.min(500, limit));
    return this.db
      .prepare(
        `
      SELECT id, task_run_id, project_id, file_path, match_count, success_flag, reason, created_at
      FROM patch_history
      WHERE project_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `,
      )
      .all(projectId, limitSafe) as Array<Record<string, unknown>>;
  }

  listTaskRuns(projectId: string, limit: number): TaskRunRow[] {
    const limitSafe = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `
      SELECT id, project_id, session_id, task_text, status, approval_budget_json, started_at, ended_at, summary
      FROM task_runs
      WHERE project_id = ?
      ORDER BY datetime(started_at) DESC
      LIMIT ?
    `,
      )
      .all(projectId, limitSafe) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      session_id: String(row.session_id),
      task_text: String(row.task_text),
      status: String(row.status),
      approval_budget: safeJsonParse<TaskBudget>(String(row.approval_budget_json ?? "{}"), defaultTaskBudget()),
      started_at: String(row.started_at),
      ended_at: row.ended_at ? String(row.ended_at) : null,
      summary: row.summary ? String(row.summary) : null,
    }));
  }

  getTaskAttempts(taskRunId: string): TaskAttemptRow[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, task_run_id, project_id, kind, summary, success_flag, metadata_json, created_at
      FROM task_attempts
      WHERE task_run_id = ?
      ORDER BY datetime(created_at) DESC
    `,
      )
      .all(taskRunId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      task_run_id: String(row.task_run_id),
      project_id: String(row.project_id),
      kind: String(row.kind),
      summary: String(row.summary),
      success_flag: Number(row.success_flag),
      metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json ?? "{}"), {}),
      created_at: String(row.created_at),
    }));
  }

  countTaskRuns(projectId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM task_runs WHERE project_id = ?")
      .get(projectId) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  countPatchHistory(projectId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM patch_history WHERE project_id = ?")
      .get(projectId) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  listUserCorrections(projectId: string, filters: UserCorrectionFilters, limit: number): MemoryRecord[] {
    const limitSafe = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `
      SELECT id, project_id, type, scope, content, summary, metadata_json, status, confidence, created_at, updated_at, last_retrieved_at, retrieval_hits
      FROM memory_records
      WHERE project_id = ? AND type IN ('rejected_fix', 'project_preference')
      ORDER BY datetime(created_at) DESC
      LIMIT 2000
    `,
      )
      .all(projectId) as Array<Record<string, unknown>>;

    const mapped = rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      type: String(row.type),
      scope: String(row.scope),
      content: String(row.content),
      summary: String(row.summary ?? ""),
      metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {}),
      status: String(row.status),
      confidence: Number(row.confidence),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_retrieved_at: row.last_retrieved_at ? String(row.last_retrieved_at) : null,
      retrieval_hits: Number(row.retrieval_hits ?? 0),
    }));

    return mapped
      .filter((row) => (filters.correction_type ? row.type === filters.correction_type : true))
      .filter((row) => {
        const appliesTo = safeJsonParse<Record<string, unknown>>(JSON.stringify(row.metadata.applies_to ?? {}), {});
        if (filters.language && String(appliesTo.language ?? row.metadata.language ?? "") !== filters.language) return false;
        if (filters.framework && String(appliesTo.framework ?? row.metadata.framework ?? "") !== filters.framework) return false;
        if (filters.toolchain && String(appliesTo.toolchain ?? row.metadata.toolchain ?? "") !== filters.toolchain) return false;
        if (filters.error_class && String(appliesTo.error_class ?? row.metadata.error_class ?? "") !== filters.error_class) return false;
        return true;
      })
      .slice(0, limitSafe);
  }

  upsertErrorSignature(input: ErrorSignatureUpsertInput): ErrorSignatureRow {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `
      SELECT id, occurrence_count
      FROM error_signatures
      WHERE project_id = ? AND signature_hash = ?
    `,
      )
      .get(input.project_id, input.signature_hash) as { id: string; occurrence_count: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE error_signatures
        SET
          workspace_relative_path = @workspace_relative_path,
          language = @language,
          toolchain = @toolchain,
          error_class = @error_class,
          normalized_message = @normalized_message,
          top_frame_symbol = @top_frame_symbol,
          file_hint = @file_hint,
          command_kind = @command_kind,
          occurrence_count = occurrence_count + 1,
          last_seen_at = @last_seen_at,
          last_observation_json = @last_observation_json,
          updated_at = @updated_at
        WHERE id = @id
      `,
        )
        .run({
          ...input,
          id: existing.id,
          last_seen_at: now,
          updated_at: now,
          last_observation_json: JSON.stringify(input.last_observation_json),
        });
      const row = this.getErrorSignatureById(existing.id);
      if (!row) throw new Error("error_signature_update_failed");
      return row;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO error_signatures (
        id, project_id, workspace_relative_path, signature_hash, language, toolchain, error_class,
        normalized_message, top_frame_symbol, file_hint, command_kind, occurrence_count,
        first_seen_at, last_seen_at, linked_memory_id, last_observation_json, created_at, updated_at
      ) VALUES (
        @id, @project_id, @workspace_relative_path, @signature_hash, @language, @toolchain, @error_class,
        @normalized_message, @top_frame_symbol, @file_hint, @command_kind, 1,
        @first_seen_at, @last_seen_at, NULL, @last_observation_json, @created_at, @updated_at
      )
    `,
      )
      .run({
        ...input,
        id,
        first_seen_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
        last_observation_json: JSON.stringify(input.last_observation_json),
      });
    const row = this.getErrorSignatureById(id);
    if (!row) throw new Error("error_signature_insert_failed");
    return row;
  }

  insertErrorOccurrence(input: {
    signature_id: string;
    project_id: string;
    task_run_id?: string | null;
    command_kind?: string | null;
    normalized_error_json: Record<string, unknown>;
    raw_log_hash?: string | null;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO error_occurrences (
        id, signature_id, project_id, task_run_id, command_kind, normalized_error_json, raw_log_hash, created_at
      ) VALUES (
        @id, @signature_id, @project_id, @task_run_id, @command_kind, @normalized_error_json, @raw_log_hash, @created_at
      )
    `,
      )
      .run({
        id,
        signature_id: input.signature_id,
        project_id: input.project_id,
        task_run_id: input.task_run_id ?? null,
        command_kind: input.command_kind ?? null,
        normalized_error_json: JSON.stringify(input.normalized_error_json),
        raw_log_hash: input.raw_log_hash ?? null,
        created_at: new Date().toISOString(),
      });
    return id;
  }

  listRecurringErrors(
    projectId: string,
    options: {
      limit: number;
      min_occurrences: number;
      language?: string;
      toolchain?: string;
      error_class?: string;
    },
  ): ErrorSignatureRow[] {
    const limitSafe = Math.max(1, Math.min(200, options.limit));
    const minOccurrences = Math.max(1, options.min_occurrences);
    const rows = this.db
      .prepare(
        `
      SELECT
        id, project_id, workspace_relative_path, signature_hash, language, toolchain, error_class,
        normalized_message, top_frame_symbol, file_hint, command_kind, occurrence_count,
        first_seen_at, last_seen_at, linked_memory_id, last_observation_json, created_at, updated_at
      FROM error_signatures
      WHERE project_id = ? AND occurrence_count >= ?
      ORDER BY occurrence_count DESC, datetime(last_seen_at) DESC
      LIMIT ?
    `,
      )
      .all(projectId, minOccurrences, limitSafe) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.mapErrorSignatureRow(row))
      .filter((row) => (options.language ? row.language === options.language : true))
      .filter((row) => (options.toolchain ? row.toolchain === options.toolchain : true))
      .filter((row) => (options.error_class ? row.error_class === options.error_class : true));
  }

  getErrorSignatureById(id: string): ErrorSignatureRow | null {
    const row = this.db
      .prepare(
        `
      SELECT
        id, project_id, workspace_relative_path, signature_hash, language, toolchain, error_class,
        normalized_message, top_frame_symbol, file_hint, command_kind, occurrence_count,
        first_seen_at, last_seen_at, linked_memory_id, last_observation_json, created_at, updated_at
      FROM error_signatures
      WHERE id = ?
    `,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapErrorSignatureRow(row) : null;
  }

  getErrorSignatureDetail(projectId: string, signatureId: string): ErrorSignatureRow | null {
    const row = this.getErrorSignatureById(signatureId);
    if (!row || row.project_id !== projectId) return null;
    return row;
  }

  listErrorOccurrences(projectId: string, signatureId: string, limit: number): ErrorOccurrenceRow[] {
    const limitSafe = Math.max(1, Math.min(200, limit));
    const rows = this.db
      .prepare(
        `
      SELECT id, signature_id, project_id, task_run_id, command_kind, normalized_error_json, raw_log_hash, created_at
      FROM error_occurrences
      WHERE project_id = ? AND signature_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `,
      )
      .all(projectId, signatureId, limitSafe) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      signature_id: String(row.signature_id),
      project_id: String(row.project_id),
      task_run_id: row.task_run_id ? String(row.task_run_id) : null,
      command_kind: row.command_kind ? String(row.command_kind) : null,
      normalized_error_json: safeJsonParse<Record<string, unknown>>(String(row.normalized_error_json ?? "{}"), {}),
      raw_log_hash: row.raw_log_hash ? String(row.raw_log_hash) : null,
      created_at: String(row.created_at),
    }));
  }

  getErrorSignatureByHash(projectId: string, signatureHash: string): ErrorSignatureRow | null {
    const row = this.db
      .prepare(
        `
      SELECT
        id, project_id, workspace_relative_path, signature_hash, language, toolchain, error_class,
        normalized_message, top_frame_symbol, file_hint, command_kind, occurrence_count,
        first_seen_at, last_seen_at, linked_memory_id, last_observation_json, created_at, updated_at
      FROM error_signatures
      WHERE project_id = ? AND signature_hash = ?
    `,
      )
      .get(projectId, signatureHash) as Record<string, unknown> | undefined;
    return row ? this.mapErrorSignatureRow(row) : null;
  }

  getLatestErrorSignatureForTaskRun(projectId: string, taskRunId: string): ErrorSignatureRow | null {
    const row = this.db
      .prepare(
        `
      SELECT es.id, es.project_id, es.workspace_relative_path, es.signature_hash, es.language, es.toolchain, es.error_class,
             es.normalized_message, es.top_frame_symbol, es.file_hint, es.command_kind, es.occurrence_count,
             es.first_seen_at, es.last_seen_at, es.linked_memory_id, es.last_observation_json, es.created_at, es.updated_at
      FROM error_occurrences eo
      INNER JOIN error_signatures es ON es.id = eo.signature_id
      WHERE eo.project_id = ? AND eo.task_run_id = ?
      ORDER BY datetime(eo.created_at) DESC
      LIMIT 1
    `,
      )
      .get(projectId, taskRunId) as Record<string, unknown> | undefined;
    return row ? this.mapErrorSignatureRow(row) : null;
  }

  getErrorSignatureByLinkedMemoryId(projectId: string, memoryId: string): ErrorSignatureRow | null {
    const row = this.db
      .prepare(
        `
      SELECT
        id, project_id, workspace_relative_path, signature_hash, language, toolchain, error_class,
        normalized_message, top_frame_symbol, file_hint, command_kind, occurrence_count,
        first_seen_at, last_seen_at, linked_memory_id, last_observation_json, created_at, updated_at
      FROM error_signatures
      WHERE project_id = ? AND linked_memory_id = ?
      LIMIT 1
    `,
      )
      .get(projectId, memoryId) as Record<string, unknown> | undefined;
    return row ? this.mapErrorSignatureRow(row) : null;
  }

  linkErrorSignatureToMemory(signatureId: string, memoryId: string): void {
    this.db
      .prepare(
        `
      UPDATE error_signatures
      SET linked_memory_id = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(memoryId, new Date().toISOString(), signatureId);
  }

  private mapErrorSignatureRow(row: Record<string, unknown>): ErrorSignatureRow {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      workspace_relative_path: String(row.workspace_relative_path),
      signature_hash: String(row.signature_hash),
      language: row.language ? String(row.language) : null,
      toolchain: row.toolchain ? String(row.toolchain) : null,
      error_class: row.error_class ? String(row.error_class) : null,
      normalized_message: String(row.normalized_message ?? ""),
      top_frame_symbol: row.top_frame_symbol ? String(row.top_frame_symbol) : null,
      file_hint: row.file_hint ? String(row.file_hint) : null,
      command_kind: row.command_kind ? String(row.command_kind) : null,
      occurrence_count: Number(row.occurrence_count ?? 0),
      first_seen_at: String(row.first_seen_at ?? ""),
      last_seen_at: String(row.last_seen_at ?? ""),
      linked_memory_id: row.linked_memory_id ? String(row.linked_memory_id) : null,
      last_observation_json: safeJsonParse<Record<string, unknown>>(String(row.last_observation_json ?? "{}"), {}),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }
}

function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function normalizeMetadata(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) normalized[key] = metadata[key];
  return JSON.stringify(normalized);
}

function buildMemorySummary(content: string, metadata: Record<string, unknown>, provided?: string): string {
  const clean = (value: unknown): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const limit = (value: string, max = 280): string => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

  if (clean(provided)) return limit(clean(provided));
  if (clean(metadata.summary)) return limit(clean(metadata.summary));
  if (clean(metadata.future_rule)) return limit(clean(metadata.future_rule));
  const rootCause = clean(metadata.root_cause);
  const fixPattern = clean(metadata.fix_pattern);
  if (rootCause && fixPattern) return limit(`Root cause: ${rootCause} Fix pattern: ${fixPattern}`);
  return limit(clean(content));
}

function buildEmbeddingText(content: string, metadata: Record<string, unknown>): string {
  const chunks: string[] = [content];
  const keys = ["error_class", "toolchain", "language", "workspace", "symptoms", "root_cause", "fix_pattern"];
  for (const key of keys) {
    const value = metadata[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      chunks.push(`${key}: ${value.join(", ")}`);
    } else {
      chunks.push(`${key}: ${String(value)}`);
    }
  }
  return chunks.join("\n");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function bufferToFloat32(blob: Buffer): Float32Array {
  const offset = blob.byteOffset;
  const length = Math.floor(blob.byteLength / 4);
  return new Float32Array(blob.buffer, offset, length);
}

function defaultTaskBudget(): TaskBudget {
  return {
    max_total_command_runs: 5,
    max_test_runs: 5,
    max_lint_runs: 3,
    max_build_runs: 3,
    max_typecheck_runs: 3,
    timeout_ms: 30000,
  };
}
