import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TARGET_REPO = "/Users/eniskorkut/Documents/New project 2/bist-research";
const TARGET_WORKSPACE = "apps/valuation";
const EXPECTED_ARGV = ["docker", "compose", "run", "--rm", "valuation-app", "python", "-m", "pytest"];

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");
const pmaPath = path.join(repoRoot, "bin", "pma.js");

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function arrayEquals(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((x, i) => String(x) === b[i]);
}

async function withClientInTarget<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase14f-target-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: [pmaPath], cwd: TARGET_REPO });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const configPath = path.join(TARGET_REPO, ".agent", "bugrecall.config.json");
  if (!existsSync(TARGET_REPO)) {
    console.error(JSON.stringify({ ok: false, reason: "target_repo_not_found", target_repo: TARGET_REPO }, null, 2));
    process.exit(1);
  }
  if (!existsSync(configPath)) {
    console.error(JSON.stringify({ ok: false, reason: "target_config_not_found", config_path: configPath }, null, 2));
    process.exit(1);
  }

  const result = await withClientInTarget(async (client) => {
    const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: TARGET_WORKSPACE } }));
    const profile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: { workspace_path: TARGET_WORKSPACE } }));
    const started = parseToolText(
      await client.callTool({
        name: "start_task_run",
        arguments: { task_text: "phase14f target override verification", workspace_path: TARGET_WORKSPACE },
      }),
    );
    const runTest = parseToolText(
      await client.callTool({
        name: "run_project_command",
        arguments: { task_run_id: String(started.task_run_id), kind: "test", workspace_path: TARGET_WORKSPACE },
      }),
    );
    return { bootstrap, profile, started, runTest };
  });

  const identity = result.profile.identity as Record<string, unknown>;
  const profileBody = result.profile.profile as Record<string, unknown>;
  const commandSources = (profileBody.command_sources as Record<string, unknown> | undefined) ?? {};
  const commandArgv = (profileBody.command_argv as Record<string, unknown> | undefined) ?? {};
  const runCommand = (result.runTest.command as Record<string, unknown> | undefined) ?? {};

  const workspaceOk = String(identity.workspace_relative_path ?? "") === TARGET_WORKSPACE;
  const testCommandOk = String(profileBody.test_command ?? "") === EXPECTED_ARGV.join(" ");
  const sourceOk = String(commandSources.test ?? "") === "config_override";
  const argvOk = arrayEquals(commandArgv.test, EXPECTED_ARGV);
  const runUsesOverride =
    String(runCommand.cmd ?? "") === EXPECTED_ARGV[0] &&
    arrayEquals(runCommand.args, EXPECTED_ARGV.slice(1)) &&
    String(runCommand.source ?? "") === "config_override";
  const noBarePytest = String(runCommand.cmd ?? "") !== "pytest";

  const ok = workspaceOk && testCommandOk && sourceOk && argvOk && runUsesOverride && noBarePytest;

  console.error(
    JSON.stringify(
      {
        ok,
        target_repo: TARGET_REPO,
        workspace_path: TARGET_WORKSPACE,
        bootstrap_project_id: result.bootstrap?.identity && (result.bootstrap.identity as Record<string, unknown>).project_id,
        get_project_profile_project_id: identity.project_id,
        get_project_profile_test_command: profileBody.test_command,
        command_sources_test: commandSources.test ?? null,
        command_argv_test: commandArgv.test ?? null,
        run_project_command_result: result.runTest,
        run_used_override: runUsesOverride,
        bare_pytest_attempted: !noBarePytest,
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
