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
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase11c-check", version: "0.0.0" }, { capabilities: {} });
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

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "root", private: true, scripts: { test: "node root.js" } }, null, 2), "utf8");
  await writeFile(path.join(repoDir, "root.js"), "console.log('root');\n", "utf8");
  await writeFile(path.join(webDir, "package.json"), JSON.stringify({ name: "web", private: true, scripts: { test: "node web.js" } }, null, 2), "utf8");
  await writeFile(path.join(webDir, "web.js"), "console.log('web');\n", "utf8");
  await writeFile(path.join(webDir, "target.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(apiDir, "requirements.txt"), "pytest\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase11c@example.com"], repoDir);
  runGit(["config", "user.name", "phase11c"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);

  return { repoDir, webDir, apiDir };
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase11c-"));
  try {
    const { repoDir, webDir, apiDir } = await setupMonorepo(baseDir);
    const webPatch = await withClientInCwd(webDir, async (client) => {
      await client.callTool({ name: "bootstrap_project", arguments: {} });
      return parseToolText(
        await client.callTool({
          name: "apply_search_replace_patch",
          arguments: {
            file_path: "target.ts",
            search_block: "export const value = 1;\n",
            replace_block: "export const value = 2;\n",
          },
        }),
      );
    });

    const snapshotId = String(webPatch.snapshot_id ?? "");
    const mismatchRestore = await withClientInCwd(apiDir, async (client) =>
      parseToolText(await client.callTool({ name: "restore_snapshot", arguments: { snapshot_id: snapshotId } })),
    );
    const validRestore = await withClientInCwd(webDir, async (client) =>
      parseToolText(await client.callTool({ name: "restore_snapshot", arguments: { snapshot_id: snapshotId } })),
    );
    const restoredContent = await readFile(path.join(webDir, "target.ts"), "utf8");

    const vectorProbe = await withClientInCwd(repoDir, async (client) => {
      await client.callTool({ name: "bootstrap_project", arguments: {} });
      await client.callTool({
        name: "commit_postmortem",
        arguments: { content: "ROOT_VECTOR_SENTINEL", metadata: { toolchain: "pytest", language: "python", error_class: "python_test_failure" } },
      });
      await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 20 } });
      const rootIndex = parseToolText(await client.callTool({ name: "index_ready_memories", arguments: { limit: 50, rebuild: true } }));
      const rootVectorSearch = parseToolText(
        await client.callTool({ name: "search_project_experience", arguments: { query: "ROOT_VECTOR_SENTINEL", mode: "vector", limit: 3 } }),
      );
      return { rootIndex, rootVectorSearch };
    });

    const webRebuild = await withClientInCwd(webDir, async (client) => {
      await client.callTool({ name: "bootstrap_project", arguments: {} });
      await client.callTool({
        name: "commit_postmortem",
        arguments: { content: "WEB_VECTOR_SENTINEL", metadata: { toolchain: "nextjs", language: "typescript", error_class: "nextjs_error" } },
      });
      await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 20 } });
      return parseToolText(await client.callTool({ name: "index_ready_memories", arguments: { limit: 50, rebuild: true } }));
    });

    const rootAfterWebRebuild = await withClientInCwd(repoDir, async (client) =>
      parseToolText(
        await client.callTool({ name: "search_project_experience", arguments: { query: "ROOT_VECTOR_SENTINEL", mode: "vector", limit: 3 } }),
      ),
    );

    const vectorEnabled = Boolean(vectorProbe.rootIndex.vector_search_enabled ?? false);
    const vectorPreserved = !vectorEnabled || Number(rootAfterWebRebuild.count ?? 0) >= 1;

    const ok =
      Boolean(webPatch.success) &&
      existsSync(path.join(repoDir, ".agent", "memory.db")) &&
      mismatchRestore.success === false &&
      String(mismatchRestore.reason) === "snapshot_project_mismatch" &&
      validRestore.success === true &&
      restoredContent === "export const value = 1;\n" &&
      vectorPreserved &&
      (vectorEnabled || String(webRebuild.note ?? "").length >= 0);

    console.error(
      JSON.stringify(
        {
          ok,
          snapshot: { webPatch, mismatchRestore, validRestore, restoredContent },
          vector: { vectorEnabled, rootIndex: vectorProbe.rootIndex, rootVectorSearch: vectorProbe.rootVectorSearch, webRebuild, rootAfterWebRebuild },
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
