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
].sort();

const codexMustNotInclude = [
  "restore_snapshot",
  "get_task_run",
  "get_vectorization_status",
  "vectorize_pending_memories",
  "start_task_run",
  "index_ready_memories",
  "apply_search_replace_patch",
];

const fullCritical = [
  "search_project_experience",
  "finalize_successful_fix",
  "get_recurring_errors",
  "record_user_correction",
  "get_memory_detail",
  "restore_snapshot",
  "vectorize_pending_memories",
  "index_ready_memories",
];

async function listToolNames(command: string, args: string[]): Promise<string[]> {
  const client = new Client({ name: "phase14b-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command, args, cwd: repoRoot });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const fullNames = await listToolNames("node", [pmaPath]);
  const codexNames = await listToolNames("env", ["BUGRECALL_TOOLSET=codex", "node", pmaPath]);

  const codexExact = codexNames.length === codexExpectedTools.length && codexExpectedTools.every((name) => codexNames.includes(name));
  const codexExcludes = codexMustNotInclude.every((name) => !codexNames.includes(name));
  const fullHasCritical = fullCritical.every((name) => fullNames.includes(name));
  const ok = codexExact && codexExcludes && fullHasCritical;

  const out = {
    ok,
    full_mode_tool_count: fullNames.length,
    codex_mode_tool_count: codexNames.length,
    codex_mode_tools: codexNames,
    full_mode_has_critical_tools: fullHasCritical,
    codex_mode_exact_match: codexExact,
    codex_mode_excludes_low_level: codexExcludes,
  };
  console.error(JSON.stringify(out, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
