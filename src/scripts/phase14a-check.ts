import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");
const pmaPath = path.join(repoRoot, "bin", "pma.js");

const codexExpectedTools = [
  "health_check",
  "bootstrap_project",
  "get_project_profile",
  "create_debug_session",
  "run_project_command",
  "record_error_observation",
  "search_project_experience",
  "suggest_next_actions",
  "finalize_successful_fix",
  "record_user_correction",
] as const;

const shouldNotExposeInCodex = [
  "vectorize_pending_memories",
  "index_ready_memories",
  "restore_snapshot",
  "apply_search_replace_patch",
  "get_vectorization_status",
] as const;

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe?.content?.find((c) => c.type === "text")?.text;
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient<T>(command: string, args: string[], fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase14a-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command, args, cwd: repoRoot });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const full = await withClient("node", [pmaPath], async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    const health = parseToolText(await client.callTool({ name: "health_check", arguments: {} }));
    return { names, health };
  });

  const codex = await withClient("env", ["BUGRECALL_TOOLSET=codex", "node", pmaPath], async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    const health = parseToolText(await client.callTool({ name: "health_check", arguments: {} }));
    const denied = await client.callTool({ name: "vectorize_pending_memories", arguments: {} });
    const deniedBody = parseToolText(denied);
    return { names, health, deniedIsError: Boolean((denied as { isError?: boolean }).isError), deniedBody };
  });

  const fullHasCritical =
    full.names.includes("search_project_experience") &&
    full.names.includes("finalize_successful_fix") &&
    full.names.includes("get_recurring_errors") &&
    full.names.includes("record_user_correction") &&
    full.names.includes("get_memory_detail");

  const codexHasExactTools =
    codex.names.length <= 10 &&
    codex.names.length === codexExpectedTools.length &&
    codexExpectedTools.every((name) => codex.names.includes(name));

  const codexHidesLowLevel = shouldNotExposeInCodex.every((name) => !codex.names.includes(name));
  const codexDeniedCheck =
    codex.deniedIsError &&
    String(codex.deniedBody.reason) === "tool_not_available_in_toolset" &&
    String(codex.deniedBody.toolset) === "codex" &&
    String(codex.deniedBody.tool_name) === "vectorize_pending_memories";

  const fullHealthOk =
    String(full.health.status) === "ok" &&
    String(full.health.active_toolset) === "full" &&
    Number(full.health.tool_count) >= full.names.length;
  const codexHealthOk =
    String(codex.health.status) === "ok" &&
    String(codex.health.active_toolset) === "codex" &&
    Number(codex.health.tool_count) === codexExpectedTools.length;

  const ok = fullHasCritical && codexHasExactTools && codexHidesLowLevel && codexDeniedCheck && fullHealthOk && codexHealthOk;
  const result = {
    ok,
    full_mode_tool_count: full.names.length,
    codex_mode_tool_count: codex.names.length,
    codex_mode_tools: codex.names,
    full_has_critical: fullHasCritical,
    codex_exact_set: codexHasExactTools,
    codex_hides_low_level: codexHidesLowLevel,
    health_full: full.health,
    health_codex: codex.health,
  };
  console.error(JSON.stringify(result, null, 2));
  if (!ok) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
