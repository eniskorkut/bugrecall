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
  const client = new Client({ name: "phase12a-check", version: "0.0.0" }, { capabilities: {} });
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
  await writeFile(path.join(repoDir, "root-test.js"), "console.log('root')\n", "utf8");
  await writeFile(path.join(repoDir, "apps", "web", "package.json"), JSON.stringify({ private: true, scripts: { test: "node web-test.js" } }, null, 2), "utf8");
  await writeFile(path.join(repoDir, "apps", "web", "web-test.js"), "console.log('web')\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase12a@example.com"], repoDir);
  runGit(["config", "user.name", "phase12a"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return { repoDir };
}

const PY_ERR_1 = `Traceback (most recent call last):
  File "main.py", line 10, in <module>
    import missing_mod
ModuleNotFoundError: No module named 'missing_mod'`;

const PY_ERR_2 = `Traceback (most recent call last):
  File "main.py", line 99, in <module>
    import missing_mod
ModuleNotFoundError: No module named 'missing_mod'`;

const PY_ERR_OTHER = `Traceback (most recent call last):
  File "main.py", line 5, in <module>
    x = 1 + "a"
TypeError: unsupported operand type(s) for +: 'int' and 'str'`;

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase12a-"));
  try {
    const { repoDir } = await createFixture(baseDir);
    const out = await withClientInCwd(repoDir, async (client) => {
      const rootBootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      const webBootstrap = parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: "apps/web" } }));

      const a1 = parseToolText(await client.callTool({ name: "ingest_terminal_error", arguments: { raw_log: PY_ERR_1 } }));
      const a2 = parseToolText(await client.callTool({ name: "ingest_terminal_error", arguments: { raw_log: PY_ERR_2 } }));
      const a3 = parseToolText(await client.callTool({ name: "ingest_terminal_error", arguments: { raw_log: PY_ERR_OTHER } }));
      const recurringRoot = parseToolText(await client.callTool({ name: "get_recurring_errors", arguments: { min_occurrences: 2 } }));

      const webSameErr = parseToolText(
        await client.callTool({ name: "ingest_terminal_error", arguments: { workspace_path: "apps/web", raw_log: PY_ERR_1 } }),
      );

      const debugSession = parseToolText(
        await client.callTool({ name: "create_debug_session", arguments: { workspace_path: "apps/web", task_text: "fix web import" } }),
      );
      const taskRunId = String(debugSession.task_run_id);
      const o1 = parseToolText(
        await client.callTool({
          name: "record_error_observation",
          arguments: { workspace_path: "apps/web", task_run_id: taskRunId, raw_output: PY_ERR_1, command_kind: "test" },
        }),
      );
      const o2 = parseToolText(
        await client.callTool({
          name: "record_error_observation",
          arguments: { workspace_path: "apps/web", task_run_id: taskRunId, raw_output: PY_ERR_2, command_kind: "test" },
        }),
      );
      const recurringWebBeforeFix = parseToolText(
        await client.callTool({ name: "get_recurring_errors", arguments: { workspace_path: "apps/web", min_occurrences: 2 } }),
      );
      const finalized = parseToolText(
        await client.callTool({
          name: "finalize_successful_fix",
          arguments: {
            workspace_path: "apps/web",
            task_run_id: taskRunId,
            summary: "fixed missing module import path",
            root_cause: "wrong path",
            fix_pattern: "fix import",
          },
        }),
      );
      const recurringWebAfterFix = parseToolText(
        await client.callTool({ name: "get_recurring_errors", arguments: { workspace_path: "apps/web", min_occurrences: 2 } }),
      );

      const explicitMismatch = parseToolText(
        await client.callTool({
          name: "finalize_successful_fix",
          arguments: {
            task_run_id: String(parseToolText(await client.callTool({ name: "create_debug_session", arguments: { task_text: "root task" } })).task_run_id),
            summary: "root finalize",
            root_cause: "root cause",
            fix_pattern: "pattern",
            error_signature_id: String(((o1.error_signature ?? {}) as Record<string, unknown>).id ?? ""),
          },
        }),
      );

      return {
        rootBootstrap,
        webBootstrap,
        a1,
        a2,
        a3,
        recurringRoot,
        webSameErr,
        o1,
        o2,
        recurringWebBeforeFix,
        finalized,
        recurringWebAfterFix,
        explicitMismatch,
      };
    });

    const s1 = (out.a1.error_signature ?? {}) as Record<string, unknown>;
    const s2 = (out.a2.error_signature ?? {}) as Record<string, unknown>;
    const s3 = (out.a3.error_signature ?? {}) as Record<string, unknown>;
    const webSig = (out.webSameErr.error_signature ?? {}) as Record<string, unknown>;
    const rootIdentity = (out.rootBootstrap.identity ?? {}) as Record<string, unknown>;
    const webIdentity = (out.webBootstrap.identity ?? {}) as Record<string, unknown>;
    const a1meta = (out.a1.metadata ?? {}) as Record<string, unknown>;
    const recurringRootRows = (out.recurringRoot.recurring_errors as Array<Record<string, unknown>>) ?? [];
    const recurringWebRowsAfter = (out.recurringWebAfterFix.recurring_errors as Array<Record<string, unknown>>) ?? [];
    const linkedId = String(out.finalized.linked_error_signature_id ?? "");
    const memoryId = String(out.finalized.memory_record_id ?? "");

    const ok =
      a1meta.memory_written === false &&
      String(s1.signature_hash) === String(s2.signature_hash) &&
      Number(s2.occurrence_count) >= 2 &&
      String(s1.signature_hash) !== String(s3.signature_hash) &&
      recurringRootRows.length >= 1 &&
      String(rootIdentity.project_id) !== String(webIdentity.project_id) &&
      String(s1.signature_hash) !== String(webSig.signature_hash) &&
      Number((out.o2.error_signature as Record<string, unknown>).occurrence_count ?? 0) >= 2 &&
      memoryId.length > 0 &&
      linkedId.length > 0 &&
      recurringWebRowsAfter.some((row) => String(row.id) === linkedId && Boolean(row.has_verified_fix)) &&
      String(out.explicitMismatch.reason) === "error_signature_project_mismatch" &&
      existsSync(path.join(repoDir, ".agent", "memory.db")) &&
      /^[a-f0-9]{64}$/.test(String(rootIdentity.project_id));

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
