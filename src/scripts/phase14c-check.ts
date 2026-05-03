import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SqliteStore } from "../db/sqlite/store.js";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");
const pmaPath = path.join(repoRoot, "bin", "pma.js");

const codexCriticalTools = [
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

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

async function withCodexClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase14c-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: "env",
    args: ["BUGRECALL_TOOLSET=codex", "node", pmaPath],
    cwd,
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function createFixture(baseDir: string): Promise<{ repoDir: string }> {
  const repoDir = path.join(baseDir, "temp-repo");
  const wsDir = path.join(repoDir, "borsapy-alert");
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(repoDir, ".gitignore"), ".agent/\n", "utf8");
  await writeFile(path.join(wsDir, "pyproject.toml"), "[project]\nname='borsapy-alert'\nversion='0.1.0'\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase14c@example.com"], repoDir);
  runGit(["config", "user.name", "phase14c"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return { repoDir };
}

function hasWorkspacePathField(inputSchema: unknown): boolean {
  const schema = inputSchema as { properties?: Record<string, unknown> } | undefined;
  return Boolean(schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, "workspace_path"));
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase14c-"));
  try {
    const { repoDir } = await createFixture(baseDir);
    const result = await withCodexClientInCwd(repoDir, async (client) => {
      const listed = await client.listTools();
      const toolMap = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const schemaCoverage = codexCriticalTools.map((name) => ({
        name,
        has_workspace_path: hasWorkspacePathField(toolMap.get(name)?.inputSchema),
      }));

      const health = parseToolText(await client.callTool({ name: "health_check", arguments: {} }));
      const bootstrap = parseToolText(
        await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "borsapy-alert" } }),
      );
      const profile = parseToolText(
        await client.callTool({ name: "get_project_profile", arguments: { workspace_path: "borsapy-alert" } }),
      );

      const created = parseToolText(
        await client.callTool({
          name: "create_debug_session",
          arguments: { task_text: "phase14c debug session", workspace_path: "borsapy-alert" },
        }),
      );

      const mismatch = parseToolText(
        await client.callTool({
          name: "run_project_command",
          arguments: { task_run_id: String(created.task_run_id ?? ""), kind: "typecheck" },
        }),
      );

      const matched = parseToolText(
        await client.callTool({
          name: "run_project_command",
          arguments: { task_run_id: String(created.task_run_id ?? ""), kind: "typecheck", workspace_path: "borsapy-alert" },
        }),
      );

      return {
        health,
        schemaCoverage,
        bootstrap,
        profile,
        created,
        mismatch,
        matched,
      };
    });

    const profileIdentity = result.profile.identity as Record<string, unknown>;
    const profileProjectId = String(profileIdentity.project_id ?? "");
    const bootstrapIdentity = result.bootstrap.identity as Record<string, unknown>;
    const bootstrapProjectId = String(bootstrapIdentity.project_id ?? "");
    const createdProjectId = String(result.created.project_id ?? "");
    const createdWorkspace = String(result.created.workspace_relative_path ?? "");
    const taskRunId = String(result.created.task_run_id ?? "");

    const dbPath = path.join(repoDir, ".agent", "memory.db");
    const store = new SqliteStore(dbPath);
    let persistedProjectId = "";
    try {
      const row = store.getTaskRunById(taskRunId);
      persistedProjectId = String(row?.project_id ?? "");
    } finally {
      store.close();
    }

    const allSchemasHaveWorkspace = result.schemaCoverage.every((entry) => entry.has_workspace_path === true);
    const identitiesMatch = profileProjectId.length > 0 && profileProjectId === bootstrapProjectId && profileProjectId === createdProjectId;
    const workspaceMatch = createdWorkspace === "borsapy-alert";
    const taskPersistedMatch = persistedProjectId === profileProjectId;
    const mismatchRejected = String(result.mismatch.reason ?? "") === "task_run_project_mismatch";
    const matchedCorrectPath =
      String(result.matched.reason ?? "") === "command_not_configured" ||
      result.matched.ok === true;

    const ok =
      String(result.health.active_toolset ?? "") === "codex" &&
      allSchemasHaveWorkspace &&
      identitiesMatch &&
      workspaceMatch &&
      taskPersistedMatch &&
      mismatchRejected &&
      matchedCorrectPath &&
      existsSync(path.join(repoDir, ".agent", "memory.db"));

    console.error(
      JSON.stringify(
        {
          ok,
          schemaCoverage: result.schemaCoverage,
          get_project_profile_project_id: profileProjectId,
          create_debug_session_project_id: createdProjectId,
          project_ids_match: identitiesMatch,
          create_debug_session_workspace_relative_path: createdWorkspace,
          task_run_persisted_project_id: persistedProjectId,
          task_run_persistence_match: taskPersistedMatch,
          mismatch_result: result.mismatch,
          matched_result: result.matched,
        },
        null,
        2,
      ),
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
