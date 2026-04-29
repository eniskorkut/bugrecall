import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase10-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const result = await withClient(async (client) => {
    await client.callTool({ name: "bootstrap_project", arguments: {} });

    const session = parseToolText(
      await client.callTool({
        name: "create_debug_session",
        arguments: {
          task_text: "Fix pytest assertion failure",
          initial_context: "phase10 fixture",
          approval_budget: { max_total_command_runs: 3, timeout_ms: 30000 },
        },
      }),
    );
    const taskRunId = String(session.task_run_id);

    const observation = parseToolText(
      await client.callTool({
        name: "record_error_observation",
        arguments: {
          task_run_id: taskRunId,
          command_kind: "test",
          raw_output: "FAILED tests/test_api.py::test_status\nE       AssertionError: assert 500 == 200\nshort test summary info",
          context: { source: "phase10-check" },
        },
      }),
    );

    const suggested = parseToolText(
      await client.callTool({
        name: "suggest_next_actions",
        arguments: {
          task_run_id: taskRunId,
          normalized_error: observation.normalized_error,
          limit: 5,
        },
      }),
    );

    const finalized = parseToolText(
      await client.callTool({
        name: "finalize_successful_fix",
        arguments: {
          task_run_id: taskRunId,
          summary: "Fixed pytest status assertion by aligning expected response status.",
          root_cause: "The API returned the wrong status for the fixture path.",
          fix_pattern: "Update handler logic and verify pytest passes.",
          symptoms: ["pytest assertion failure"],
          verification_steps: ["run test"],
          files_changed: ["tests/test_api.py"],
          error_class: "python_test_failure",
          language: "python",
          toolchain: "pytest",
          confidence: 0.92,
        },
      }),
    );
    const afterFinalize = parseToolText(await client.callTool({ name: "get_task_run", arguments: { task_run_id: taskRunId } }));

    const failedSession = parseToolText(
      await client.callTool({
        name: "create_debug_session",
        arguments: { task_text: "Fail fixture session" },
      }),
    );
    const failed = parseToolText(
      await client.callTool({
        name: "fail_debug_session",
        arguments: { task_run_id: String(failedSession.task_run_id), reason: "phase10 failure fixture" },
      }),
    );
    const afterFail = parseToolText(
      await client.callTool({ name: "get_task_run", arguments: { task_run_id: String(failedSession.task_run_id) } }),
    );

    const tools = await client.listTools();
    return {
      session,
      observation,
      suggested,
      finalized,
      afterFinalize,
      failedSession,
      failed,
      afterFail,
      tools: (tools.tools ?? []).map((t) => t.name),
    };
  });

  const ok =
    result.session.ok === true &&
    Array.isArray(result.session.recommended_flow) &&
    typeof result.observation.normalized_error === "object" &&
    typeof result.observation.suggested_search_query === "string" &&
    Array.isArray(result.suggested.suggested_actions) &&
    (result.suggested.suggested_actions as unknown[]).length >= 3 &&
    result.finalized.vectorization_status === "pending_vectorization" &&
    result.afterFinalize.status === "succeeded" &&
    result.failed.status === "failed" &&
    result.afterFail.status === "failed" &&
    result.tools.includes("create_debug_session") &&
    result.tools.includes("record_error_observation") &&
    result.tools.includes("suggest_next_actions") &&
    result.tools.includes("finalize_successful_fix") &&
    result.tools.includes("fail_debug_session");

  console.error(JSON.stringify({ ok, result }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
