import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");
const pmaPath = path.join(repoRoot, "bin", "pma.js");

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase14d-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: [pmaPath], cwd });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function commandLooksLikePythonModule(command: unknown, moduleName: string): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim().toLowerCase();
  return (
    (normalized.startsWith("python -m ") || normalized.startsWith("python3 -m ")) &&
    normalized.includes(`-m ${moduleName}`)
  );
}

function warningIncludes(warnings: unknown, needle: string): boolean {
  if (!Array.isArray(warnings)) return false;
  return warnings.map((w) => String(w)).includes(needle);
}

async function createRepoWithWorkspace(baseDir: string, workspaceName: string, pyprojectContent: string): Promise<string> {
  const repoDir = path.join(baseDir, `repo-${workspaceName}`);
  const wsDir = path.join(repoDir, workspaceName);
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(repoDir, ".gitignore"), ".agent/\n", "utf8");
  await writeFile(path.join(wsDir, "pyproject.toml"), pyprojectContent, "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase14d@example.com"], repoDir);
  runGit(["config", "user.name", "phase14d"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

async function fetchProfile(client: Client, workspacePath: string): Promise<Record<string, unknown>> {
  await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: workspacePath } });
  return parseToolText(await client.callTool({ name: "get_project_profile", arguments: { workspace_path: workspacePath } }));
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase14d-"));
  try {
    const repo1 = await createRepoWithWorkspace(
      baseDir,
      "borsapy-alert",
      `[project]
name = "borsapy-alert"
version = "0.1.0"
`,
    );
    const repo2 = await createRepoWithWorkspace(
      baseDir,
      "with-pytest",
      `[project]
name = "with-pytest"
version = "0.1.0"

[tool.pytest.ini_options]
minversion = "7.0"
`,
    );
    const repo3 = await createRepoWithWorkspace(
      baseDir,
      "with-mypy",
      `[project]
name = "with-mypy"
version = "0.1.0"

[tool.mypy]
python_version = "3.12"
`,
    );
    const repo4 = await createRepoWithWorkspace(
      baseDir,
      "with-ruff",
      `[project]
name = "with-ruff"
version = "0.1.0"

[tool.ruff]
line-length = 100
`,
    );
    const repo5 = await createRepoWithWorkspace(
      baseDir,
      "with-build",
      `[project]
name = "with-build"
version = "0.1.0"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
`,
    );

    const case1 = await withClientInCwd(repo1, async (client) => {
      const profile = await fetchProfile(client, "borsapy-alert");
      const profileBody = profile.profile as Record<string, unknown>;
      const warnings = profile.warnings;

      const started = parseToolText(
        await client.callTool({
          name: "start_task_run",
          arguments: { task_text: "phase14d no-mypy", workspace_path: "borsapy-alert" },
        }),
      );
      const typecheck = parseToolText(
        await client.callTool({
          name: "run_project_command",
          arguments: { task_run_id: String(started.task_run_id), kind: "typecheck", workspace_path: "borsapy-alert" },
        }),
      );

      return { profileBody, warnings, typecheck };
    });

    const case2 = await withClientInCwd(repo2, async (client) => {
      const profile = await fetchProfile(client, "with-pytest");
      return profile.profile as Record<string, unknown>;
    });
    const case3 = await withClientInCwd(repo3, async (client) => {
      const profile = await fetchProfile(client, "with-mypy");
      return profile.profile as Record<string, unknown>;
    });
    const case4 = await withClientInCwd(repo4, async (client) => {
      const profile = await fetchProfile(client, "with-ruff");
      return profile.profile as Record<string, unknown>;
    });
    const case5 = await withClientInCwd(repo5, async (client) => {
      const profile = await fetchProfile(client, "with-build");
      return { profile: profile.profile as Record<string, unknown>, warnings: profile.warnings };
    });

    const case1Ok =
      Array.isArray(case1.profileBody.languages) &&
      case1.profileBody.languages.map((x) => String(x)).includes("python") &&
      case1.profileBody.test_command === null &&
      case1.profileBody.lint_command === null &&
      case1.profileBody.typecheck_command === null &&
      case1.profileBody.build_command === null &&
      warningIncludes(case1.warnings, "pytest_not_configured") &&
      warningIncludes(case1.warnings, "mypy_not_configured") &&
      warningIncludes(case1.warnings, "ruff_not_configured") &&
      warningIncludes(case1.warnings, "python_build_not_configured") &&
      String(case1.typecheck.reason) === "command_not_configured" &&
      String(case1.typecheck.kind) === "typecheck" &&
      typeof case1.typecheck.project_id === "string" &&
      typeof case1.typecheck.workspace_relative_path === "string";

    const case2Ok =
      commandLooksLikePythonModule(case2.test_command, "pytest") &&
      String(case2.test_command).trim().toLowerCase() !== "pytest";

    const case3Ok =
      commandLooksLikePythonModule(case3.typecheck_command, "mypy") &&
      String(case3.typecheck_command).trim().toLowerCase() !== "mypy .";

    const case4Ok =
      commandLooksLikePythonModule(case4.lint_command, "ruff") &&
      String(case4.lint_command).trim().toLowerCase() !== "ruff check .";

    const case5Ok =
      commandLooksLikePythonModule(case5.profile.build_command, "build") &&
      warningIncludes(case5.warnings, "python_build_module_not_declared");

    const ok = case1Ok && case2Ok && case3Ok && case4Ok && case5Ok;
    console.error(
      JSON.stringify(
        {
          ok,
          case1: {
            profile: case1.profileBody,
            warnings: case1.warnings,
            run_project_command_typecheck: case1.typecheck,
          },
          case2_test_command: case2.test_command,
          case3_typecheck_command: case3.typecheck_command,
          case4_lint_command: case4.lint_command,
          case5_build_command: case5.profile.build_command,
          case5_warnings: case5.warnings,
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
