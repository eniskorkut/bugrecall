import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const safe = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function isErrorResult(result: unknown): boolean {
  const safe = result as { isError?: boolean };
  return Boolean(safe.isError);
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase11d-check", version: "0.0.0" }, { capabilities: {} });
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

async function createFixture(baseDir: string): Promise<{ repoDir: string }> {
  const repoDir = path.join(baseDir, "repo");
  const webSrc = path.join(repoDir, "apps", "web", "src");
  const apiDir = path.join(repoDir, "services", "api");
  await mkdir(webSrc, { recursive: true });
  await mkdir(apiDir, { recursive: true });

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node root-test.js" } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(repoDir, "root-test.js"), "console.log('ROOT_TEST_RAN')\n", "utf8");
  await writeFile(
    path.join(repoDir, "apps", "web", "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node web-test.js", typecheck: "node web-typecheck.js" } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(repoDir, "apps", "web", "web-test.js"), "console.log('WEB_TEST_RAN')\n", "utf8");
  await writeFile(path.join(repoDir, "apps", "web", "web-typecheck.js"), "console.log('WEB_TYPECHECK_RAN')\n", "utf8");
  await writeFile(path.join(repoDir, "apps", "web", "src", "target.txt"), "hello web", "utf8");
  await writeFile(path.join(repoDir, "services", "api", "pyproject.toml"), "[project]\nname='api'\nversion='0.1.0'\n", "utf8");
  await writeFile(path.join(repoDir, "services", "api", "check.py"), "print('API_CHECK_RAN')\n", "utf8");
  await writeFile(path.join(repoDir, "services", "api", "target.py"), "print('safe')\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase11d@example.com"], repoDir);
  runGit(["config", "user.name", "phase11d"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return { repoDir };
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase11d-"));
  try {
    const { repoDir } = await createFixture(baseDir);
    const result = await withClientInCwd(repoDir, async (client) => {
      const rootBootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const rootProfile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: {} }));
      const webBootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "apps/web" } }));
      const webProfile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: { workspace_path: "apps/web" } }));
      const apiBootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "services/api" } }));
      const apiProfile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: { workspace_path: "services/api" } }));

      const startedWeb = parseToolText(
        await client.callTool({ name: "start_task_run", arguments: { task_text: "web test", workspace_path: "apps/web" } }),
      );
      const runWeb = parseToolText(
        await client.callTool({
          name: "run_project_command",
          arguments: { task_run_id: String(startedWeb.task_run_id), kind: "test", workspace_path: "apps/web" },
        }),
      );

      const patch = parseToolText(
        await client.callTool({
          name: "apply_search_replace_patch",
          arguments: {
            workspace_path: "apps/web",
            file_path: "src/target.txt",
            search_block: "hello web",
            replace_block: "hello patched web",
          },
        }),
      );
      const mismatch = await client.callTool({
        name: "restore_snapshot",
        arguments: { workspace_path: "services/api", snapshot_id: String(patch.snapshot_id) },
      });
      const mismatchBody = parseToolText(mismatch);
      const restoreOk = parseToolText(
        await client.callTool({
          name: "restore_snapshot",
          arguments: { workspace_path: "apps/web", snapshot_id: String(patch.snapshot_id) },
        }),
      );

      const badOutside = await client.callTool({ name: "get_project_profile", arguments: { workspace_path: "../outside" } });
      const badMissing = await client.callTool({ name: "get_project_profile", arguments: { workspace_path: "missing/workspace" } });
      const badFile = await client.callTool({ name: "get_project_profile", arguments: { workspace_path: "root-test.js" } });

      return {
        rootBootstrap,
        rootProfile,
        webBootstrap,
        webProfile,
        apiBootstrap,
        apiProfile,
        runWeb,
        patch,
        mismatchIsError: isErrorResult(mismatch),
        mismatchBody,
        restoreOk,
        badOutsideIsError: isErrorResult(badOutside),
        badOutsideBody: parseToolText(badOutside),
        badMissingIsError: isErrorResult(badMissing),
        badMissingBody: parseToolText(badMissing),
        badFileIsError: isErrorResult(badFile),
        badFileBody: parseToolText(badFile),
      };
    });

    const rootIdentity = result.rootBootstrap.identity as Record<string, unknown>;
    const webIdentity = result.webBootstrap.identity as Record<string, unknown>;
    const apiIdentity = result.apiBootstrap.identity as Record<string, unknown>;
    const rootProfile = result.rootProfile.profile as Record<string, unknown>;
    const webProfile = result.webProfile.profile as Record<string, unknown>;
    const apiProfile = result.apiProfile.profile as Record<string, unknown>;
    const webContent = await readFile(path.join(repoDir, "apps", "web", "src", "target.txt"), "utf8");

    const ok =
      String(rootIdentity.workspace_relative_path) === "." &&
      String(webIdentity.workspace_relative_path) === "apps/web" &&
      String(apiIdentity.workspace_relative_path) === "services/api" &&
      String(rootProfile.test_command) === "npm run test" &&
      String(webProfile.test_command) === "npm run test" &&
      String(apiProfile.package_manager) !== "npm" &&
      String(result.runWeb.combined_tail ?? "").includes("WEB_TEST_RAN") &&
      !String(result.runWeb.combined_tail ?? "").includes("ROOT_TEST_RAN") &&
      result.patch.success === true &&
      String(result.mismatchBody.reason) === "snapshot_project_mismatch" &&
      result.restoreOk.success === true &&
      webContent === "hello web" &&
      result.badOutsideIsError === true &&
      (String(result.badOutsideBody.reason) === "workspace_path_outside_repo" || String(result.badOutsideBody.reason) === "invalid_workspace_path") &&
      result.badMissingIsError === true &&
      String(result.badMissingBody.reason) === "workspace_path_not_found" &&
      result.badFileIsError === true &&
      String(result.badFileBody.reason) === "workspace_path_not_directory" &&
      existsSync(path.join(repoDir, ".agent", "memory.db")) &&
      !existsSync(path.join(repoDir, "apps", "web", ".agent", "memory.db")) &&
      !existsSync(path.join(repoDir, "services", "api", ".agent", "memory.db")) &&
      /^[a-f0-9]{64}$/.test(String(rootIdentity.project_id)) &&
      /^[a-f0-9]{64}$/.test(String(webIdentity.project_id)) &&
      /^[a-f0-9]{64}$/.test(String(apiIdentity.project_id));

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
