import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const client = new Client({ name: "phase5a-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);

  const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
  const projectId = String((bootstrap.identity as Record<string, unknown>).project_id);

  await client.callTool({
    name: "commit_postmortem",
    arguments: {
      type: "incident",
      scope: "workspace-only",
      content: "Pytest assertion failure for login flow",
      confidence: 0.9,
      metadata: { toolchain: "pytest", language: "python", error_class: "python_test_failure", workspace: "." },
    },
  });
  await client.callTool({
    name: "commit_postmortem",
    arguments: {
      type: "incident",
      scope: "workspace-only",
      content: "TS2322 type mismatch in src/session.ts",
      confidence: 0.92,
      metadata: { toolchain: "tsc", language: "typescript", error_class: "typescript_type_error", workspace: "." },
    },
  });

  const pendingBefore = parseToolText(await client.callTool({ name: "get_vectorization_status", arguments: {} }));
  const t0 = performance.now();
  const vectorized = parseToolText(
    await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 10, retry_failed: false } }),
  );
  const t1 = performance.now();
  const pendingAfter = parseToolText(await client.callTool({ name: "get_vectorization_status", arguments: {} }));

  const db = new Database(".agent/memory.db", { readonly: true });
  const rows = db
    .prepare("SELECT record_id, project_id, model, dimension, length(vector_blob) AS blob_len FROM embedding_cache WHERE project_id = ?")
    .all(projectId) as Array<{ record_id: string; project_id: string; model: string; dimension: number; blob_len: number }>;
  db.close();

  const processed = Number(vectorized.processed_count ?? 0);
  const readyCount = Number(vectorized.ready_count ?? 0);
  const failedCount = Number(vectorized.failed_count ?? 0);
  const embeddedCount = Number(pendingAfter.embedded_count ?? 0);
  const dimensionOk = rows.length > 0 && rows.every((r) => Number(r.dimension) === 384 && Number(r.blob_len) > 0);
  const statusTransitionOk =
    Number(pendingBefore.pending_count ?? 0) >= 2 &&
    Number(pendingAfter.ready_count ?? 0) >= 2 &&
    Number(pendingAfter.pending_count ?? 0) <= Number(pendingBefore.pending_count ?? 0);

  const ok = processed >= 2 && readyCount >= 2 && failedCount === 0 && embeddedCount >= 2 && dimensionOk && statusTransitionOk;

  console.error(
    JSON.stringify(
      {
        ok,
        model_load_seconds: Number(((t1 - t0) / 1000).toFixed(2)),
        pending_before: pendingBefore,
        vectorize_result: vectorized,
        pending_after: pendingAfter,
        embedding_cache_rows: rows,
      },
      null,
      2,
    ),
  );

  await client.close();
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
