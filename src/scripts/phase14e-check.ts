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

function warningIncludes(warnings: unknown, needle: string): boolean {
  return Array.isArray(warnings) && warnings.map((x) => String(x)).includes(needle);
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase14e-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: [pmaPath], cwd });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function createFixture(baseDir: string): Promise<string> {
  const repoDir = path.join(baseDir, "repo");
  await mkdir(path.join(repoDir, "borsapy-alert"), { recursive: true });
  await mkdir(path.join(repoDir, "with-pytest"), { recursive: true });
  await mkdir(path.join(repoDir, "with-mypy"), { recursive: true });
  await mkdir(path.join(repoDir, "with-ruff"), { recursive: true });
  await mkdir(path.join(repoDir, "with-build"), { recursive: true });
  await writeFile(path.join(repoDir, ".gitignore"), ".agent/\n", "utf8");
  await writeFile(path.join(repoDir, "borsapy-alert", "pyproject.toml"), "[project]\nname='borsapy-alert'\nversion='0.1.0'\n", "utf8");
  await writeFile(
    path.join(repoDir, "with-pytest", "pyproject.toml"),
    "[project]\nname='with-pytest'\nversion='0.1.0'\n\n[tool.pytest.ini_options]\nminversion='7.0'\n",
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "with-mypy", "pyproject.toml"),
    "[project]\nname='with-mypy'\nversion='0.1.0'\n\n[tool.mypy]\npython_version='3.12'\n",
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "with-ruff", "pyproject.toml"),
    "[project]\nname='with-ruff'\nversion='0.1.0'\n\n[tool.ruff]\nline-length=100\n",
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "with-build", "pyproject.toml"),
    "[project]\nname='with-build'\nversion='0.1.0'\n\n[build-system]\nrequires=['setuptools>=68']\nbuild-backend='setuptools.build_meta'\n",
    "utf8",
  );
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase14e@example.com"], repoDir);
  runGit(["config", "user.name", "phase14e"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

async function getProfile(client: Client, workspacePath: string): Promise<Record<string, unknown>> {
  await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: workspacePath } });
  return parseToolText(await client.callTool({ name: "get_project_profile", arguments: { workspace_path: workspacePath } }));
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase14e-"));
  try {
    const repoDir = await createFixture(baseDir);
    const result = await withClientInCwd(repoDir, async (client) => {
      const case1Profile = await getProfile(client, "borsapy-alert");
      const started = parseToolText(
        await client.callTool({ name: "start_task_run", arguments: { task_text: "no config", workspace_path: "borsapy-alert" } }),
      );
      const case1Run = parseToolText(
        await client.callTool({
          name: "run_project_command",
          arguments: { task_run_id: String(started.task_run_id), kind: "typecheck", workspace_path: "borsapy-alert" },
        }),
      );

      await mkdir(path.join(repoDir, ".agent"), { recursive: true });
      await writeFile(
        path.join(repoDir, ".agent", "bugrecall.config.json"),
        JSON.stringify(
          {
            workspaces: {
              "borsapy-alert": {
                commands: {
                  test: ["docker", "compose", "run", "--rm", "valuation-app", "python", "-m", "pytest"],
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const case2Profile = await getProfile(client, "borsapy-alert");
      const started2 = parseToolText(
        await client.callTool({ name: "start_task_run", arguments: { task_text: "docker override", workspace_path: "borsapy-alert" } }),
      );
      const case2Run = parseToolText(
        await client.callTool({
          name: "run_project_command",
          arguments: { task_run_id: String(started2.task_run_id), kind: "test", workspace_path: "borsapy-alert" },
        }),
      );

      await rm(path.join(repoDir, ".agent", "bugrecall.config.json"), { force: true });
      await writeFile(
        path.join(repoDir, "bugrecall.config.json"),
        JSON.stringify(
          {
            commands: {
              test: ["docker", "compose", "run", "--rm", "valuation-app", "python", "-m", "pytest"],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const case3Profile = await getProfile(client, "borsapy-alert");

      await writeFile(
        path.join(repoDir, "bugrecall.config.json"),
        JSON.stringify(
          {
            workspaces: {
              "borsapy-alert": {
                commands: {
                  test: "docker compose run --rm valuation-app python -m pytest",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const case4Profile = await getProfile(client, "borsapy-alert");

      await writeFile(
        path.join(repoDir, "bugrecall.config.json"),
        JSON.stringify(
          {
            workspaces: {
              "borsapy-alert": {
                commands: {
                  test: ["sh", "-c", "rm -rf ."],
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const case5Profile = await getProfile(client, "borsapy-alert");

      await writeFile(
        path.join(repoDir, "bugrecall.config.json"),
        JSON.stringify(
          {
            workspaces: {
              "borsapy-alert": {
                commands: {
                  test: ["docker", "compose", "run", "--rm", "valuation-app", "python", "-m", "pytest", ";", "rm"],
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const case6Profile = await getProfile(client, "borsapy-alert");

      await rm(path.join(repoDir, "bugrecall.config.json"), { force: true });
      const phase14dPytest = await getProfile(client, "with-pytest");
      const phase14dMypy = await getProfile(client, "with-mypy");
      const phase14dRuff = await getProfile(client, "with-ruff");
      const phase14dBuild = await getProfile(client, "with-build");

      return {
        case1Profile,
        case1Run,
        case2Profile,
        case2Run,
        case3Profile,
        case4Profile,
        case5Profile,
        case6Profile,
        phase14dPytest,
        phase14dMypy,
        phase14dRuff,
        phase14dBuild,
      };
    });

    const p1 = result.case1Profile.profile as Record<string, unknown>;
    const p2 = result.case2Profile.profile as Record<string, unknown>;
    const p3 = result.case3Profile.profile as Record<string, unknown>;
    const p4 = result.case4Profile.profile as Record<string, unknown>;
    const p5 = result.case5Profile.profile as Record<string, unknown>;
    const p6 = result.case6Profile.profile as Record<string, unknown>;
    const pPy = result.phase14dPytest.profile as Record<string, unknown>;
    const pMy = result.phase14dMypy.profile as Record<string, unknown>;
    const pRu = result.phase14dRuff.profile as Record<string, unknown>;
    const pBu = result.phase14dBuild.profile as Record<string, unknown>;

    const case1Ok =
      p1.test_command === null &&
      p1.typecheck_command === null &&
      String(result.case1Run.reason) === "command_not_configured";
    const case2Argv = (p2.command_argv as Record<string, unknown> | undefined)?.test;
    const case2ExpectedArgv = ["docker", "compose", "run", "--rm", "valuation-app", "python", "-m", "pytest"];
    const case2ArgvMatch =
      Array.isArray(case2Argv) &&
      case2Argv.length === case2ExpectedArgv.length &&
      case2ExpectedArgv.every((v, i) => (case2Argv as string[])[i] === v);
    const case2Ok =
      String(p2.test_command) === "docker compose run --rm valuation-app python -m pytest" &&
      String((p2.command_sources as Record<string, unknown> | undefined)?.test ?? "") === "config_override" &&
      case2ArgvMatch &&
      String(result.case2Run.reason) !== "command_not_configured" &&
      (result.case2Run.ok === true || String(result.case2Run.signal) === "SPAWN_ERROR");
    const case3Ok = String(p3.test_command) === "docker compose run --rm valuation-app python -m pytest";
    const case4Ok = p4.test_command === null && warningIncludes(result.case4Profile.warnings, "invalid_command_override_format");
    const case5Ok = p5.test_command === null && warningIncludes(result.case5Profile.warnings, "unsafe_command_override_ignored");
    const case6Ok = p6.test_command === null && warningIncludes(result.case6Profile.warnings, "unsafe_command_override_ignored");
    const case7Ok =
      String(pPy.test_command).includes("-m pytest") &&
      String(pMy.typecheck_command).includes("-m mypy") &&
      String(pRu.lint_command).includes("-m ruff check .") &&
      String(pBu.build_command).includes("-m build");

    const ok = case1Ok && case2Ok && case3Ok && case4Ok && case5Ok && case6Ok && case7Ok;
    console.error(JSON.stringify({ ok, result }, null, 2));
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
