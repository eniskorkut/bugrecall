import Database from "better-sqlite3";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase8-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const dbPath = path.join(root, ".agent", "memory.db");
  const result = await withClient(async (client) => {
    const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
    const projectId = String((bootstrap.identity as Record<string, unknown>).project_id);

    const started = parseToolText(
      await client.callTool({
        name: "start_task_run",
        arguments: {
          task_text: "phase8 check run",
          approval_budget: {
            max_total_command_runs: 2,
            max_test_runs: 1,
            max_lint_runs: 1,
            max_build_runs: 1,
            max_typecheck_runs: 1,
            timeout_ms: 30000,
          },
        },
      }),
    );
    const taskRunId = String(started.task_run_id);

    const runOk = parseToolText(
      await client.callTool({ name: "run_project_command", arguments: { task_run_id: taskRunId, kind: "typecheck" } }),
    );
    const runFail = parseToolText(
      await client.callTool({ name: "run_project_command", arguments: { task_run_id: taskRunId, kind: "lint" } }),
    );
    const runBlocked = parseToolText(
      await client.callTool({ name: "run_project_command", arguments: { task_run_id: taskRunId, kind: "build" } }),
    );

    const getTask = parseToolText(await client.callTool({ name: "get_task_run", arguments: { task_run_id: taskRunId } }));

    const logged = parseToolText(
      await client.callTool({
        name: "log_attempt",
        arguments: {
          task_run_id: taskRunId,
          kind: "reasoning",
          summary: "manual reasoning note",
          success: true,
          metadata: { source: "phase8-check" },
        },
      }),
    );

    let invalidKindRejected = false;
    try {
      await client.callTool({ name: "run_project_command", arguments: { task_run_id: taskRunId, kind: "run" } });
    } catch {
      invalidKindRejected = true;
    }

    const db = new Database(dbPath);
    db.prepare("UPDATE project_profiles SET test_command_json = ? WHERE project_id = ?")
      .run(JSON.stringify(["npm test && echo hacked"]), projectId);
    db.close();

    const startedUnsafe = parseToolText(
      await client.callTool({
        name: "start_task_run",
        arguments: {
          task_text: "phase8 unsafe command check",
          approval_budget: { max_total_command_runs: 2, max_test_runs: 2, timeout_ms: 30000 },
        },
      }),
    );
    const runUnsafe = parseToolText(
      await client.callTool({ name: "run_project_command", arguments: { task_run_id: String(startedUnsafe.task_run_id), kind: "test" } }),
    );

    const tools = await client.listTools();

    return {
      started,
      runOk,
      runFail,
      runBlocked,
      getTask,
      logged,
      invalidKindRejected,
      startedUnsafe,
      runUnsafe,
      tools: (tools.tools ?? []).map((t) => t.name),
    };
  });

  const ok =
    result.started.ok === true &&
    result.runOk.ok === true &&
    result.runOk.success === true &&
    result.runFail.ok === true &&
    result.runFail.success === false &&
    typeof result.runFail.normalized_error === "string" &&
    result.runBlocked.ok === false &&
    result.runBlocked.reason === "budget_exceeded" &&
    Number((result.getTask.command_usage as Record<string, unknown>).total ?? 0) >= 2 &&
    result.logged.ok === true &&
    result.invalidKindRejected === true &&
    result.runUnsafe.ok === false &&
    result.runUnsafe.reason === "unsafe_command_profile" &&
    result.tools.includes("start_task_run") &&
    result.tools.includes("run_project_command") &&
    result.tools.includes("log_attempt") &&
    result.tools.includes("get_task_run");

  console.error(JSON.stringify({ ok, result }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
