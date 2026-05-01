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
  const client = new Client({ name: "phase12d-check", version: "0.0.0" }, { capabilities: {} });
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
  await writeFile(
    path.join(repoDir, "apps", "web", "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node web-test.js" } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(repoDir, "apps", "web", "web-test.js"), "console.log('WEB')\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase12d@example.com"], repoDir);
  runGit(["config", "user.name", "phase12d"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return { repoDir };
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase12d-"));
  try {
    const { repoDir } = await createFixture(baseDir);
    const out = await withClientInCwd(repoDir, async (client) => {
      const rootBoot = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const webBoot = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "apps/web" } }));

      const errLog = `Error: Hydration failed at app/page.tsx:17:4`;
      const dbg = parseToolText(await client.callTool({ name: "create_debug_session", arguments: { task_text: "fix hydration" } }));
      const taskRunId = String(dbg.task_run_id ?? "");
      const observed = parseToolText(
        await client.callTool({ name: "record_error_observation", arguments: { task_run_id: taskRunId, raw_output: errLog, command_kind: "build" } }),
      );
      const finalized = parseToolText(
        await client.callTool({
          name: "finalize_successful_fix",
          arguments: {
            task_run_id: taskRunId,
            summary: "hydration fixed with client boundary",
            root_cause: "unstable hydration",
            fix_pattern: "client boundary",
            error_class: "nextjs_error",
            toolchain: "nextjs",
            language: "typescript",
          },
        }),
      );
      const linkedSignatureId = String(finalized.linked_error_signature_id ?? (observed.error_signature as Record<string, unknown>)?.id ?? "");

      await client.callTool({
        name: "commit_postmortem",
        arguments: {
          type: "fact",
          scope: "workspace-only",
          content: "hydration issue facts and generic info",
          metadata: { framework: "react", toolchain: "webpack", language: "javascript", error_class: "generic" },
          confidence: 0.7,
        },
      });

      await client.callTool({
        name: "commit_postmortem",
        arguments: {
          type: "incident",
          scope: "workspace-only",
          content: "stale hydration memory",
          metadata: { framework: "nextjs", toolchain: "nextjs", language: "typescript", error_class: "nextjs_error", stale: true },
          confidence: 0.95,
        },
      });

      const correction = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            correction_type: "rejected_fix",
            context: "hydration mismatch",
            user_feedback: "avoid suppressHydrationWarning",
            rejected_pattern: "suppressHydrationWarning",
            preferred_pattern: "deterministic client boundary",
            future_rule: "Do not use suppressHydrationWarning as primary fix.",
            applies_to: { framework: "nextjs", toolchain: "nextjs", error_class: "nextjs_error" },
          },
        }),
      );

      const signatureSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: {
            query: "hydration boundary",
            error_signature_id: linkedSignatureId,
            limit: 10,
            detail_level: "summary",
          },
        }),
      );

      const filteredSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: {
            query: "hydration",
            filters: { framework: "nextjs", toolchain: "nextjs", error_class: "nextjs_error" },
            limit: 10,
          },
        }),
      );

      const noWarnSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: { query: "suppressHydrationWarning", include_warnings: false, limit: 10 },
        }),
      );

      const fullSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: { query: "hydration boundary", detail_level: "full", limit: 10 },
        }),
      );

      const webSearch = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: { workspace_path: "apps/web", query: "hydration boundary", limit: 10 },
        }),
      );

      return {
        rootBoot,
        webBoot,
        finalized,
        correction,
        signatureSearch,
        filteredSearch,
        noWarnSearch,
        fullSearch,
        webSearch,
      };
    });

    const signatureResults = (out.signatureSearch.results as Array<Record<string, unknown>>) ?? [];
    const filteredResults = (out.filteredSearch.results as Array<Record<string, unknown>>) ?? [];
    const fullResults = (out.fullSearch.results as Array<Record<string, unknown>>) ?? [];
    const webResults = (out.webSearch.results as Array<Record<string, unknown>>) ?? [];
    const warningsSignature = (out.signatureSearch.warnings as Array<Record<string, unknown>>) ?? [];
    const warningsFiltered = (out.filteredSearch.warnings as Array<Record<string, unknown>>) ?? [];
    const noWarn = (out.noWarnSearch.warnings as Array<Record<string, unknown>>) ?? [];
    const linkedMemoryId = String(out.finalized.memory_record_id ?? "");

    const firstSignature = signatureResults[0] ?? {};
    const staleRows = filteredResults.filter((row) => (row.ranking_reasons as string[] | undefined)?.includes("stale_penalty_applied"));
    const hasBreakdown = filteredResults.some((row) => typeof (row.ranking_breakdown as Record<string, unknown>)?.final_score === "number");
    const onlySummaryInDefault = filteredResults.every((row) => String(row.content ?? "").length <= String(row.summary ?? "").length + 2);
    const fullContainsLong = fullResults.some((row) => String(row.content ?? "").length >= String(row.summary ?? "").length);
    const correctedNotInResults = filteredResults.every((row) => String(row.type) !== "rejected_fix");

    const checks = {
      linkedMemoryFirst: String(firstSignature.id) === linkedMemoryId,
      retrievalLevelLinked: String(firstSignature.retrieval_level) === "signature_linked_memory",
      reasonsIncludeLinked: ((firstSignature.ranking_reasons as string[]) ?? []).includes("signature_linked_memory"),
      filteredHasRows: filteredResults.length > 0,
      hasBreakdown,
      onlySummaryInDefault,
      fullContainsLong,
      correctedNotInResults,
      hasRejectedWarningScore: [...warningsSignature, ...warningsFiltered].some(
        (w) => String(w.type) === "rejected_fix" && typeof w.warning_score === "number",
      ),
      hasWarningReasons: [...warningsSignature, ...warningsFiltered].some(
        (w) => Array.isArray(w.warning_reasons) && (w.warning_reasons as string[]).length > 0,
      ),
      noWarningsWhenDisabled: noWarn.length === 0,
      webIsolation: webResults.length === 0,
      stalePenaltyObserved: staleRows.length >= 1,
      dbCreated: existsSync(path.join(repoDir, ".agent", "memory.db")),
      workspaceProjectIdsDiffer:
        String((out.rootBoot.identity as Record<string, unknown>).project_id) !==
        String((out.webBoot.identity as Record<string, unknown>).project_id),
    };

    const ok = Object.values(checks).every(Boolean);

    console.error(JSON.stringify({ ok, checks, out }, null, 2));
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
