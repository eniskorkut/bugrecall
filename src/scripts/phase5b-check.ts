import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient<T>(
  fn: (client: Client) => Promise<T>,
  envOverrides?: Record<string, string | undefined>,
): Promise<T> {
  const client = new Client({ name: "phase5b-check", version: "0.0.0" }, { capabilities: {} });
  const args = envOverrides
    ? [
        ...Object.entries(envOverrides).map(([k, v]) => `${k}=${v ?? ""}`),
        "node",
        "bin/pma.js",
      ]
    : ["bin/pma.js"];
  const command = envOverrides ? "env" : "node";
  const transport = new StdioClientTransport({ command, args });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const enabledResult = await withClient(async (client) => {
    const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
    const projectId = String((bootstrap.identity as Record<string, unknown>).project_id);

    await client.callTool({
      name: "commit_postmortem",
      arguments: {
        type: "incident",
        scope: "workspace-only",
        content: "Phase5B enabled check TS2322",
        confidence: 0.9,
        metadata: { toolchain: "tsc", language: "typescript", error_class: "typescript_type_error", workspace: "." },
      },
    });

    const first = parseToolText(
      await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 10, retry_failed: false } }),
    );

    const db = new Database(".agent/memory.db");
    const row = db
      .prepare("SELECT id FROM memory_records WHERE project_id = ? AND status = 'ready' ORDER BY datetime(updated_at) DESC LIMIT 1")
      .get(projectId) as { id: string } | undefined;
    if (row) {
      db.prepare("UPDATE memory_records SET status = 'pending_vectorization' WHERE id = ?").run(row.id);
    }
    db.close();

    const second = parseToolText(
      await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 10, retry_failed: false } }),
    );
    const status = parseToolText(await client.callTool({ name: "get_vectorization_status", arguments: {} }));
    return { first, second, status };
  });

  const disabledResult = await withClient(async (client) => {
    await client.callTool({
      name: "commit_postmortem",
      arguments: {
        type: "incident",
        scope: "workspace-only",
        content: "Phase5B disabled check should stay pending",
        confidence: 0.9,
        metadata: { toolchain: "pytest", language: "python", error_class: "python_test_failure", workspace: "." },
      },
    });
    const before = parseToolText(await client.callTool({ name: "get_vectorization_status", arguments: {} }));
    const run = parseToolText(await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 5 } }));
    const after = parseToolText(await client.callTool({ name: "get_vectorization_status", arguments: {} }));
    return { before, run, after };
  }, { BUGRECALL_EMBEDDINGS: "off" });

  const enabledOk =
    enabledResult.first.embeddings_enabled === true &&
    Number(enabledResult.first.ready_count ?? 0) >= 1 &&
    Number(enabledResult.second.skipped_count ?? 0) >= 1 &&
    enabledResult.status.worker_state !== "disabled";

  const disabledOk =
    disabledResult.run.embeddings_enabled === false &&
    disabledResult.run.worker_state === "disabled" &&
    Number(disabledResult.after.pending_count ?? 0) >= Number(disabledResult.before.pending_count ?? 0);

  const ok = enabledOk && disabledOk;
  console.error(
    JSON.stringify(
      {
        ok,
        enabled: enabledResult,
        disabled: disabledResult,
      },
      null,
      2,
    ),
  );

  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
