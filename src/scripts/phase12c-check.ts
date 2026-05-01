import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  const client = new Client({ name: "phase12c-check", version: "0.0.0" }, { capabilities: {} });
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
  await mkdir(path.join(repoDir, "apps", "web"), { recursive: true });
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ private: true, scripts: { test: "node root-test.js" } }, null, 2), "utf8");
  await writeFile(path.join(repoDir, "root-test.js"), "console.log('ROOT')\n", "utf8");
  await writeFile(path.join(repoDir, "apps", "web", "package.json"), JSON.stringify({ private: true, scripts: { test: "node web-test.js" } }, null, 2), "utf8");
  await writeFile(path.join(repoDir, "apps", "web", "web-test.js"), "console.log('WEB')\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase12c@example.com"], repoDir);
  runGit(["config", "user.name", "phase12c"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return { repoDir };
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase12c-"));
  try {
    const { repoDir } = await createFixture(baseDir);
    const out = await withClientInCwd(repoDir, async (client) => {
      const rootBoot = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const webBoot = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "apps/web" } }));

      const longContent = `This is a very long verified memory content. `.repeat(30);
      const committed = parseToolText(
        await client.callTool({
          name: "commit_postmortem",
          arguments: {
            type: "incident",
            scope: "workspace-only",
            content: longContent,
            metadata: { root_cause: "bad hydration boundary", fix_pattern: "split client boundary", error_class: "nextjs_error" },
          },
        }),
      );
      const memoryId = String(committed.record_id ?? "");
      const detailSame = parseToolText(await client.callTool({ name: "get_memory_detail", arguments: { memory_id: memoryId } }));
      const detailOtherWorkspace = parseToolText(
        await client.callTool({ name: "get_memory_detail", arguments: { workspace_path: "apps/web", memory_id: memoryId } }),
      );

      const correction = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            correction_type: "rejected_fix",
            context: "hydration mismatch",
            user_feedback: "this project does not accept suppressHydrationWarning",
            rejected_pattern: "suppressHydrationWarning",
            preferred_pattern: "client boundary",
            future_rule: "Avoid suppressHydrationWarning as primary fix.",
          },
        }),
      );

      const defaultSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: { query: "hydration suppressHydrationWarning", mode: "text", limit: 10 },
        }),
      );
      const fullSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: { query: "hydration", mode: "text", detail_level: "full", limit: 10 },
        }),
      );

      const errLog = `Error: Hydration failed at app/page.tsx:17:4`;
      const dbg = parseToolText(await client.callTool({ name: "create_debug_session", arguments: { task_text: "fix hydration" } }));
      const taskRunId = String(dbg.task_run_id ?? "");
      const observed = parseToolText(
        await client.callTool({
          name: "record_error_observation",
          arguments: { task_run_id: taskRunId, raw_output: errLog, command_kind: "build" },
        }),
      );
      const finalized = parseToolText(
        await client.callTool({
          name: "finalize_successful_fix",
          arguments: {
            task_run_id: taskRunId,
            summary: "hydrate fix",
            root_cause: "unstable render",
            fix_pattern: "client boundary split",
          },
        }),
      );
      const signatureId = String(finalized.linked_error_signature_id ?? (observed.error_signature as Record<string, unknown>)?.id ?? "");
      const signatureSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: { query: "hydrate", error_signature_id: signatureId, limit: 5 },
        }),
      );

      const badCommit = parseToolText(
        await client.callTool({
          name: "commit_postmortem",
          arguments: { type: "rejected_fix", scope: "workspace-only", content: "bad", metadata: {} },
        }),
      );

      const webList = parseToolText(await client.callTool({ name: "list_user_corrections", arguments: { workspace_path: "apps/web" } }));

      return {
        rootBoot,
        webBoot,
        committed,
        detailSame,
        detailOtherWorkspace,
        correction,
        defaultSearch,
        fullSearch,
        signatureSearch,
        badCommit,
        webList,
      };
    });

    const detailMemory = (out.detailSame.memory as Record<string, unknown>) ?? {};
    const summary = String(detailMemory.summary ?? "");
    const content = String(detailMemory.content ?? "");
    const defaultResults = (out.defaultSearch.results as Array<Record<string, unknown>>) ?? [];
    const fullResults = (out.fullSearch.results as Array<Record<string, unknown>>) ?? [];
    const signatureResults = (out.signatureSearch.results as Array<Record<string, unknown>>) ?? [];
    const warnings = (out.defaultSearch.warnings as Array<Record<string, unknown>>) ?? [];
    const signatureLookup = (out.signatureSearch.signature_lookup as Record<string, unknown>) ?? {};
    const webCorrections = (out.webList.corrections as Array<Record<string, unknown>>) ?? [];

    const ok =
      String(out.committed.status) === "pending_vectorization" &&
      summary.length > 0 &&
      content.length > 0 &&
      summary.length <= content.length &&
      String(out.correction.memory_type) === "rejected_fix" &&
      defaultResults.length > 0 &&
      defaultResults.every((row) => row.detail_available === true && typeof row.summary === "string") &&
      fullResults.length > 0 &&
      fullResults.some((row) => String(row.content).length >= String(row.summary ?? "").length) &&
      String(out.detailOtherWorkspace.reason) === "memory_project_mismatch" &&
      warnings.some((w) => typeof w.summary === "string" && w.detail_available === true) &&
      signatureResults.length > 0 &&
      String((signatureResults[0] ?? {}).retrieval_level).length > 0 &&
      signatureLookup.requested === true &&
      existsSync(path.join(repoDir, ".agent", "memory.db")) &&
      String(out.badCommit.reason) === "invalid_arguments" &&
      webCorrections.length === 0 &&
      String((out.rootBoot.identity as Record<string, unknown>).project_id) !==
        String((out.webBoot.identity as Record<string, unknown>).project_id);

    console.error(JSON.stringify({ ok, out }, null, 2));
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

