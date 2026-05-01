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

function isErrorResult(result: unknown): boolean {
  const safe = result as { isError?: boolean };
  return Boolean(safe.isError);
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase12b-check", version: "0.0.0" }, { capabilities: {} });
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
  runGit(["config", "user.email", "phase12b@example.com"], repoDir);
  runGit(["config", "user.name", "phase12b"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return { repoDir };
}

const NEXT_HYDRATION_ERR = `Error: Hydration failed because the initial UI does not match what was rendered on the server.
at app/page.tsx:17:10`;

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase12b-"));
  try {
    const { repoDir } = await createFixture(baseDir);
    const out = await withClientInCwd(repoDir, async (client) => {
      const rootBoot = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const webBoot = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "apps/web" } }));

      const rootSig = parseToolText(await client.callTool({ name: "ingest_terminal_error", arguments: { raw_log: NEXT_HYDRATION_ERR } }));
      const webSig = parseToolText(await client.callTool({ name: "ingest_terminal_error", arguments: { workspace_path: "apps/web", raw_log: NEXT_HYDRATION_ERR } }));
      const rootSigId = String(((rootSig.error_signature ?? {}) as Record<string, unknown>).id ?? "");
      const webSigId = String(((webSig.error_signature ?? {}) as Record<string, unknown>).id ?? "");

      const corrA = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            correction_type: "rejected_fix",
            context: "hydration mismatch in next app",
            user_feedback: "do not use suppressHydrationWarning",
            rejected_pattern: "suppressHydrationWarning",
            preferred_pattern: "client boundary",
            future_rule: "Avoid suppressHydrationWarning as primary fix in this project.",
            applies_to: { error_class: "nextjs_error", framework: "nextjs", toolchain: "nextjs", error_signature_id: rootSigId },
          },
        }),
      );

      const listRootAll = parseToolText(await client.callTool({ name: "list_user_corrections", arguments: { limit: 50 } }));

      const corrWeb = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            workspace_path: "apps/web",
            correction_type: "project_preference",
            context: "web integration test policy",
            user_feedback: "prefer test containers",
            future_rule: "Use test container in integration tests.",
            applies_to: { language: "typescript", toolchain: "vitest" },
          },
        }),
      );

      const listWeb = parseToolText(await client.callTool({ name: "list_user_corrections", arguments: { workspace_path: "apps/web", limit: 50 } }));
      const listRootRejected = parseToolText(await client.callTool({ name: "list_user_corrections", arguments: { correction_type: "rejected_fix" } }));

      const debugWeb = parseToolText(await client.callTool({ name: "create_debug_session", arguments: { workspace_path: "apps/web", task_text: "fix hydration" } }));
      const debugWebTaskId = String(debugWeb.task_run_id);
      await client.callTool({
        name: "record_error_observation",
        arguments: { workspace_path: "apps/web", task_run_id: debugWebTaskId, raw_output: NEXT_HYDRATION_ERR, command_kind: "build" },
      });
      const suggestWeb = parseToolText(
        await client.callTool({ name: "suggest_next_actions", arguments: { workspace_path: "apps/web", task_run_id: debugWebTaskId, query: "suppressHydrationWarning hydration" } }),
      );

      const searchRoot = parseToolText(
        await client.callTool({ name: "search_project_experience", arguments: { query: "suppressHydrationWarning hydration", limit: 10 } }),
      );

      const rootDbg = parseToolText(await client.callTool({ name: "create_debug_session", arguments: { task_text: "root fix" } }));
      const rootDbgTaskId = String(rootDbg.task_run_id);
      await client.callTool({
        name: "record_error_observation",
        arguments: { task_run_id: rootDbgTaskId, raw_output: NEXT_HYDRATION_ERR, command_kind: "build" },
      });
      const rootFinal = parseToolText(
        await client.callTool({ name: "finalize_successful_fix", arguments: { task_run_id: rootDbgTaskId, summary: "root fixed", root_cause: "mismatch", fix_pattern: "boundary" } }),
      );
      const rootRecurringBefore = parseToolText(await client.callTool({ name: "get_recurring_errors", arguments: { min_occurrences: 1 } }));

      const corrB = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            correction_type: "project_preference",
            context: "after verified fix",
            user_feedback: "keep pattern strict",
            future_rule: "Preserve strict typing.",
            applies_to: { error_signature_id: rootSigId },
          },
        }),
      );
      const rootRecurringAfter = parseToolText(await client.callTool({ name: "get_recurring_errors", arguments: { min_occurrences: 1 } }));

      const mismatchSig = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            correction_type: "rejected_fix",
            context: "cross workspace mismatch",
            user_feedback: "should fail",
            future_rule: "do not allow cross project signature",
            applies_to: { error_signature_id: webSigId },
          },
        }),
      );

      const badWorkspaceRaw = await client.callTool({
        name: "record_user_correction",
        arguments: {
          workspace_path: "../outside",
          correction_type: "project_preference",
          context: "bad",
          user_feedback: "bad",
          future_rule: "bad",
        },
      });
      const badWorkspace = parseToolText(badWorkspaceRaw);

      const badFile = parseToolText(
        await client.callTool({
          name: "record_user_correction",
          arguments: {
            correction_type: "project_preference",
            context: "bad file path",
            user_feedback: "bad path",
            future_rule: "bad",
            applies_to: { file_path: "../outside.ts" },
          },
        }),
      );

      const appJs = await readFile(path.join(repoRoot, "src", "dashboard", "static", "app.js"), "utf8");

      return {
        rootBoot,
        webBoot,
        corrA,
        corrB,
        corrWeb,
        listRootAll,
        listWeb,
        listRootRejected,
        searchRoot,
        suggestWeb,
        rootFinal,
        rootRecurringBefore,
        rootRecurringAfter,
        mismatchSig,
        badWorkspaceIsError: isErrorResult(badWorkspaceRaw),
        badWorkspace,
        badFile,
        appJs,
      };
    });

    const rootProjectId = String((out.rootBoot.identity as Record<string, unknown>).project_id ?? "");
    const webProjectId = String((out.webBoot.identity as Record<string, unknown>).project_id ?? "");
    const corrAId = String(out.corrA.memory_id ?? "");
    const rootCorrections = (out.listRootAll.corrections as Array<Record<string, unknown>>) ?? [];
    const webCorrections = (out.listWeb.corrections as Array<Record<string, unknown>>) ?? [];
    const rootWarnings = (out.searchRoot.warnings as Array<Record<string, unknown>>) ?? [];
    const suggestCautions = (out.suggestWeb.cautions as string[]) ?? [];
    const recurringBeforeRows = (out.rootRecurringBefore.recurring_errors as Array<Record<string, unknown>>) ?? [];
    const recurringAfterRows = (out.rootRecurringAfter.recurring_errors as Array<Record<string, unknown>>) ?? [];
    const linkedBefore = recurringBeforeRows.find((r) => typeof r.linked_memory_id === "string" && String(r.linked_memory_id).length > 0);
    const linkedAfter = recurringAfterRows.find((r) => linkedBefore && String(r.id) === String(linkedBefore.id));
    const appJs = String(out.appJs ?? "");

    const ok =
      corrAId.length > 0 &&
      String(out.corrA.memory_type) === "rejected_fix" &&
      String(((out.corrA.metadata ?? {}) as Record<string, unknown>).verification_status) === "user_preference_not_test_verified" &&
      rootCorrections.some((c) => String(c.id) === corrAId) &&
      !webCorrections.some((c) => String(c.id) === corrAId) &&
      rootProjectId !== webProjectId &&
      ((out.listRootRejected.corrections as Array<Record<string, unknown>>) ?? []).every((c) => String(c.type) === "rejected_fix") &&
      rootWarnings.some((w) => String(w.type) === "rejected_fix" && String(w.future_rule).length > 0) &&
      suggestCautions.some((c) => c.toLowerCase().includes("avoid")) &&
      String(out.mismatchSig.reason) === "error_signature_project_mismatch" &&
      out.badWorkspaceIsError === true &&
      String(out.badWorkspace.reason).includes("workspace_path_") &&
      String(out.badFile.reason) === "path_traversal_rejected" &&
      existsSync(path.join(repoDir, ".agent", "memory.db")) &&
      /^[a-f0-9]{64}$/.test(rootProjectId) &&
      appJs.includes("function escapeHtml(") &&
      appJs.includes("renderRecurringErrors") &&
      appJs.includes("renderUserCorrections") &&
      (!linkedBefore || (linkedAfter && String(linkedAfter.linked_memory_id) === String(linkedBefore.linked_memory_id)));

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
