import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIdentityAndProfile, ensureStore, recordUserCorrection } from "../index.js";
import { handleApiRequest } from "../dashboard/routes.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

async function createFixture(baseDir: string): Promise<string> {
  const repoDir = path.join(baseDir, "repo");
  await mkdir(path.join(repoDir, "apps", "web"), { recursive: true });
  await mkdir(path.join(repoDir, "examples"), { recursive: true });
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ private: true, scripts: { test: "node test.js" } }, null, 2), "utf8");
  await writeFile(path.join(repoDir, "test.js"), "console.log('ok')\n", "utf8");
  await writeFile(path.join(repoDir, "examples", "agent-instruction-full.md"), "TARGET_FAKE_TEMPLATE_SHOULD_NOT_BE_USED", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "phase13c@example.com"], repoDir);
  runGit(["config", "user.name", "phase13c"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

async function api(cwd: string, method: string, route: string, query = "", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(`http://127.0.0.1${route}${query}`);
  const res = await handleApiRequest(cwd, method, route, url, body ? JSON.stringify(body) : "");
  return { status: res.status, ...res.body };
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase13c-"));
  try {
    const repoDir = await createFixture(baseDir);
    const data = await buildIdentityAndProfile(repoDir);
    const { store } = await ensureStore(data.agentRoot);
    try {
      store.runMigrations();
      store.upsertProject(data.identity);
      store.upsertProjectProfile(data.identity.project_id, data.profile);
      const m = store.insertMemoryRecord(data.identity.project_id, {
        type: "incident",
        scope: "workspace-only",
        content: "phase13c memory",
        confidence: 0.9,
        metadata: { error_class: "typescript_error", toolchain: "tsc", language: "typescript", summary: "phase13c summary" },
      });

      const exportBefore = await api(repoDir, "GET", "/api/export");
      assert(exportBefore.ok === true, "export should succeed");
      assert(Array.isArray(exportBefore.memories) && exportBefore.memories.some((row: Record<string, unknown>) => row.id === m.id), "export missing memory");

      const del1 = await api(repoDir, "DELETE", `/api/memories/${encodeURIComponent(m.id)}`);
      assert(del1.ok === true && del1.deleted === true, "first memory delete should succeed");
      const del2 = await api(repoDir, "DELETE", `/api/memories/${encodeURIComponent(m.id)}`);
      assert(del2.ok === false && del2.reason === "not_found", "second memory delete should return not_found");

      const normal = store.insertMemoryRecord(data.identity.project_id, {
        type: "incident",
        scope: "workspace-only",
        content: "not correction",
        confidence: 0.8,
        metadata: { summary: "not correction" },
      });
      const correction = await recordUserCorrection(repoDir, {
        correction_type: "rejected_fix",
        context: "bad fix",
        user_feedback: "don't do this",
        future_rule: "avoid this",
        rejected_pattern: "as any",
        preferred_pattern: "fix type",
        confidence: 0.9,
      });
      const correctionId = String(correction.memory_id);
      const delCorr = await api(repoDir, "DELETE", `/api/user-corrections/${encodeURIComponent(correctionId)}`);
      assert(delCorr.ok === true && delCorr.deleted === true, "user correction delete should succeed");
      const delCorrBad = await api(repoDir, "DELETE", `/api/user-corrections/${encodeURIComponent(normal.id)}`);
      assert(delCorrBad.ok === false && delCorrBad.reason === "not_user_correction", "non-correction delete should reject");

      const sig = store.upsertErrorSignature({
        project_id: data.identity.project_id,
        workspace_relative_path: data.identity.workspace_relative_path,
        signature_hash: "phase13c-hash",
        language: "typescript",
        toolchain: "tsc",
        error_class: "typescript_error",
        normalized_message: "TS error",
        top_frame_symbol: null,
        file_hint: "src/a.ts",
        command_kind: "typecheck",
        last_observation_json: { error: "TS2322" },
      });
      store.insertErrorOccurrence({
        signature_id: sig.id,
        project_id: data.identity.project_id,
        task_run_id: null,
        command_kind: "typecheck",
        normalized_error_json: { error: "TS2322", file: "src/a.ts" },
        raw_log_hash: "abc",
      });
      store.insertErrorOccurrence({
        signature_id: sig.id,
        project_id: data.identity.project_id,
        task_run_id: null,
        command_kind: "typecheck",
        normalized_error_json: { error: "TS2322", file: "src/a.ts" },
        raw_log_hash: "def",
      });

      const recurringDetail = await api(repoDir, "GET", `/api/recurring-errors/${encodeURIComponent(sig.id)}`);
      assert(recurringDetail.ok === true, "recurring detail should succeed");
      assert(Array.isArray(recurringDetail.occurrences) && recurringDetail.occurrences.length >= 2, "recurring detail should include occurrences");

      const instructions = await api(repoDir, "GET", "/api/agent-instructions");
      assert(instructions.ok === true, "agent instructions should succeed");
      const templates = instructions.templates as Record<string, unknown>;
      assert(Boolean(templates.minimal) && Boolean(templates.full) && Boolean(templates.monorepo), "missing instruction templates");
      const full = String(templates.full ?? "");
      const minimal = String(templates.minimal ?? "");
      const monorepo = String(templates.monorepo ?? "");
      assert(!full.includes("TARGET_FAKE_TEMPLATE_SHOULD_NOT_BE_USED"), "agent instructions incorrectly loaded target project examples");
      assert(full.includes("bootstrap_project"), "full instruction should include bootstrap_project");
      assert(full.includes("search_project_experience"), "full instruction should include search_project_experience");
      assert(monorepo.includes("workspace_path"), "monorepo instruction should include workspace_path");
      assert(minimal.length > 20, "minimal instruction should be non-trivial");
    } finally {
      store.close();
    }

    const scriptFile = fileURLToPath(import.meta.url);
    const scriptDir = path.dirname(scriptFile);
    const repoRoot = path.resolve(scriptDir, "../..");
    const appJs = readFileSync(path.join(repoRoot, "src/dashboard/static/app.js"), "utf8");
    assert(appJs.includes("export-btn"), "app.js missing export handler");
    assert(appJs.includes("delete-memory-btn"), "app.js missing delete memory handler");
    assert(appJs.includes("copy-instruction-btn"), "app.js missing copy instruction handler");
    assert(appJs.includes("escapeHtml"), "app.js missing escaping helper");

    const docsAndExamples = [
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "docs", "local-data.md"),
      path.join(repoRoot, "docs", "tool-workflows.md"),
      path.join(repoRoot, "docs", "integrations", "generic-mcp.md"),
      path.join(repoRoot, "examples", "mcp-config.generic.json"),
      path.join(repoRoot, "examples", "mcp-config.with-env.json"),
    ]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    assert(!docsAndExamples.includes("/Users/"), "docs/examples contain local absolute /Users/ path");

    execFileSync("npm", ["run", "phase13b:check"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.error(JSON.stringify({ ok: true }, null, 2));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
