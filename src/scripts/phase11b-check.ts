import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");
const pmaPath = path.join(repoRoot, "bin", "pma.js");

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase11b-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: [pmaPath], cwd });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

async function setupMonorepo(baseDir: string): Promise<{ repoDir: string; webDir: string; apiDir: string }> {
  const repoDir = path.join(baseDir, "repo");
  const webDir = path.join(repoDir, "apps", "web");
  const apiDir = path.join(repoDir, "packages", "api");
  await mkdir(webDir, { recursive: true });
  await mkdir(apiDir, { recursive: true });

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "monorepo-root",
        private: true,
        scripts: {
          test: "node root-test.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(repoDir, "root-test.js"), "console.log('ROOT_TEST_OK');\n", "utf8");

  await writeFile(
    path.join(webDir, "package.json"),
    JSON.stringify(
      {
        name: "web-app",
        private: true,
        scripts: {
          test: "node web-test.js",
          typecheck: "node web-typecheck.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(webDir, "web-test.js"), "console.log('WEB_TEST_OK');\n", "utf8");
  await writeFile(path.join(webDir, "web-typecheck.js"), "console.log('WEB_TYPECHECK_OK');\n", "utf8");

  await writeFile(path.join(apiDir, "requirements.txt"), "pytest\n", "utf8");
  await writeFile(path.join(apiDir, "check.py"), "print('API_OK')\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase11b@example.com"], repoDir);
  runGit(["config", "user.name", "phase11b"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);

  return { repoDir, webDir, apiDir };
}

async function startTask(client: Client): Promise<string> {
  const started = parseToolText(
    await client.callTool({
      name: "start_task_run",
      arguments: {
        task_text: "phase11b command check",
        approval_budget: { max_total_command_runs: 3, max_test_runs: 3, timeout_ms: 15000 },
      },
    }),
  );
  return String(started.task_run_id);
}

async function runTestCommand(client: Client, taskRunId: string): Promise<Record<string, unknown>> {
  return parseToolText(
    await client.callTool({
      name: "run_project_command",
      arguments: { task_run_id: taskRunId, kind: "test" },
    }),
  );
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase11b-"));
  try {
    const { repoDir, webDir, apiDir } = await setupMonorepo(baseDir);

    const rootResult = await withClientInCwd(repoDir, async (client) => {
      const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const profile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: {} }));
      const run = await runTestCommand(client, await startTask(client));
      return { bootstrap, profile, run };
    });

    const webResult = await withClientInCwd(webDir, async (client) => {
      const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const profile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: {} }));
      const run = await runTestCommand(client, await startTask(client));
      return { bootstrap, profile, run };
    });

    const apiResult = await withClientInCwd(apiDir, async (client) => {
      const bootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const profile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: {} }));
      return { bootstrap, profile };
    });

    const rootIdentity = rootResult.bootstrap.identity as Record<string, unknown>;
    const webIdentity = webResult.bootstrap.identity as Record<string, unknown>;
    const apiIdentity = apiResult.bootstrap.identity as Record<string, unknown>;
    const rootProfile = rootResult.profile.profile as Record<string, unknown>;
    const webProfile = webResult.profile.profile as Record<string, unknown>;
    const apiProfile = apiResult.profile.profile as Record<string, unknown>;

    const rootOut = String(rootResult.run.combined_tail ?? "");
    const webOut = String(webResult.run.combined_tail ?? "");

    const agentDbPath = path.join(repoDir, ".agent", "memory.db");
    const agentDbInWeb = path.join(webDir, ".agent", "memory.db");

    const projectIds = [
      String(rootIdentity.project_id ?? ""),
      String(webIdentity.project_id ?? ""),
      String(apiIdentity.project_id ?? ""),
    ];

    const ok =
      String(rootIdentity.workspace_relative_path) === "." &&
      String(webIdentity.workspace_relative_path) === "apps/web" &&
      String(apiIdentity.workspace_relative_path) === "packages/api" &&
      String(rootProfile.test_command) === "npm run test" &&
      String(webProfile.test_command) === "npm run test" &&
      String(webProfile.typecheck_command) === "npm run typecheck" &&
      Array.isArray(apiProfile.languages) &&
      (apiProfile.languages as unknown[]).includes("python") &&
      String(apiProfile.package_manager) !== "npm" &&
      rootOut.includes("ROOT_TEST_OK") &&
      webOut.includes("WEB_TEST_OK") &&
      !webOut.includes("ROOT_TEST_OK") &&
      existsSync(agentDbPath) &&
      !existsSync(agentDbInWeb) &&
      new Set(projectIds).size === 3 &&
      projectIds.every((id) => /^[a-f0-9]{64}$/.test(id));

    console.error(
      JSON.stringify(
        {
          ok,
          identities: { rootIdentity, webIdentity, apiIdentity },
          profiles: { rootProfile, webProfile, apiProfile },
          command_output: { rootOut, webOut },
          agent_paths: { agentDbPath, agentDbInWeb },
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
