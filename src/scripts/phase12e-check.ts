import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runRetrievalEval } from "../engine/evaluation/retrievalEval.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");
  const pmaPath = path.join(repoRoot, "bin", "pma.js");
  const client = new Client({ name: "phase12e-check", version: "0.0.0" }, { capabilities: {} });
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
  await mkdir(path.join(repoDir, "apps", "web"), { recursive: true });
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ private: true, scripts: { test: "node root-test.js" } }, null, 2), "utf8");
  await writeFile(path.join(repoDir, "root-test.js"), "console.log('ROOT_TEST_RAN')\n", "utf8");
  await writeFile(
    path.join(repoDir, "apps", "web", "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node web-test.js" } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(repoDir, "apps", "web", "web-test.js"), "console.log('WEB_TEST_RAN')\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase12e@example.com"], repoDir);
  runGit(["config", "user.name", "phase12e"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

async function signatureLinkedCase(): Promise<{ ok: boolean; details: Record<string, unknown> }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase12e-"));
  try {
    const repoDir = await createFixture(baseDir);
    return await withClientInCwd(repoDir, async (client) => {
      parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "apps/web" } }));

      const debug = parseToolText(
        await client.callTool({
          name: "create_debug_session",
          arguments: { workspace_path: "apps/web", task_text: "fix hydration mismatch" },
        }),
      );
      const taskRunId = String(debug.task_run_id ?? "");
      const observed = parseToolText(
        await client.callTool({
          name: "record_error_observation",
          arguments: {
            workspace_path: "apps/web",
            task_run_id: taskRunId,
            raw_output: "Error: Hydration failed because text content does not match server-rendered HTML at app/page.tsx:12",
            command_kind: "build",
          },
        }),
      );
      const finalized = parseToolText(
        await client.callTool({
          name: "finalize_successful_fix",
          arguments: {
            workspace_path: "apps/web",
            task_run_id: taskRunId,
            summary: "Hydration mismatch fixed by client boundary.",
            root_cause: "browser-only render branch",
            fix_pattern: "move browser state to useEffect/client boundary",
            error_class: "nextjs_hydration_error",
            language: "typescript",
            toolchain: "nextjs",
          },
        }),
      );
      const signatureId =
        String(finalized.linked_error_signature_id ?? "") ||
        String((observed.error_signature as Record<string, unknown> | undefined)?.id ?? "");
      const memoryId = String(finalized.memory_record_id ?? "");

      const search = parseToolText(
        await client.callTool({
          name: "search_project_experience",
          arguments: {
            workspace_path: "apps/web",
            query: "hydration mismatch",
            error_signature_id: signatureId,
            detail_level: "summary",
            mode: "text",
            limit: 5,
          },
        }),
      );

      const first = Array.isArray(search.results) && search.results.length > 0 ? (search.results[0] as Record<string, unknown>) : {};
      const reasons = Array.isArray(first.ranking_reasons) ? (first.ranking_reasons as string[]) : [];
      const ok =
        String(first.id ?? "") === memoryId &&
        String(first.retrieval_level ?? "") === "signature_linked_memory" &&
        reasons.includes("signature_linked_memory");
      return { ok, details: { observed, finalized, search } };
    });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");
  const fixturePath = path.join(repoRoot, "eval", "retrieval", "basic-debug-memory.json");

  const evalReport = await runRetrievalEval({ fixturePath });
  const signatureCase = await signatureLinkedCase();
  const hasBreakdown = evalReport.cases.some((c) => c.sample_ranking_breakdown && c.sample_ranking_reasons.length > 0);
  const warningSeen = evalReport.cases.some((c) => c.warning_labels.length > 0);
  const correctionNotInTop = evalReport.cases.every((c) => !c.top_labels.some((l) => l.startsWith("reject_")));

  const ok =
    evalReport.passed &&
    evalReport.metrics.top1_accuracy >= evalReport.thresholds.top1_accuracy &&
    evalReport.metrics.top3_recall >= evalReport.thresholds.top3_recall &&
    evalReport.metrics.warning_recall >= evalReport.thresholds.warning_recall &&
    evalReport.metrics.false_positive_count === 0 &&
    hasBreakdown &&
    warningSeen &&
    correctionNotInTop &&
    signatureCase.ok;

  console.error(JSON.stringify({ ok, evalReport, signatureCase }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
