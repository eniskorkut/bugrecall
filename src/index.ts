import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { normalizeTerminalError } from "./engine/normalization/index.js";
import type { CommandKind } from "./engine/normalization/types.js";
import { extractSignatureFields } from "./engine/signatures/errorSignature.js";
import { getEmbeddingClient } from "./engine/embedding/embeddingClient.js";
import { getEmbeddingConfig } from "./engine/embedding/config.js";
import { clearVectorProject, getVectorStoreStatus, upsertVectors } from "./db/vector/lanceStore.js";
import { runHybridSearch } from "./engine/retrieval/hybridSearch.js";
import { rankSearchResults, rankWarnings, type RankingContext } from "./engine/retrieval/ranking.js";
import {
  type CommitPostmortemInput,
  type ProjectIdentityRow,
  type ProjectProfileRow,
  type SearchExperienceFilters,
  type StructuredCommand,
  type TaskBudget,
  type ErrorSignatureRow,
  SqliteStore,
} from "./db/sqlite/store.js";

const server = new Server(
  {
    name: "project-memory-agent",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

type ProjectProfile = ProjectProfileRow;

type ProjectIdentity = ProjectIdentityRow;
const memoryTypeValues = ["incident", "fact", "decision", "rejected_fix", "project_preference"] as const;
type MemoryType = (typeof memoryTypeValues)[number];
type ToolsetMode = "full" | "codex";

const fullToolNames = [
  "health_check",
  "bootstrap_project",
  "get_project_profile",
  "read_project_memory",
  "commit_postmortem",
  "ingest_terminal_error",
  "search_project_experience",
  "get_memory_detail",
  "get_recurring_errors",
  "record_user_correction",
  "list_user_corrections",
  "index_ready_memories",
  "apply_search_replace_patch",
  "restore_snapshot",
  "start_task_run",
  "get_task_run",
  "run_project_command",
  "log_attempt",
  "create_debug_session",
  "record_error_observation",
  "suggest_next_actions",
  "finalize_successful_fix",
  "fail_debug_session",
  "vectorize_pending_memories",
  "get_vectorization_status",
] as const;

const codexToolNames = [
  "health_check",
  "bootstrap_project",
  "get_project_profile",
  "create_debug_session",
  "run_project_command",
  "record_error_observation",
  "search_project_experience",
  "suggest_next_actions",
  "finalize_successful_fix",
  "record_user_correction",
] as const;

function resolveActiveToolset(): ToolsetMode {
  const raw = process.env.BUGRECALL_TOOLSET?.trim().toLowerCase();
  if (!raw || raw === "full") {
    return "full";
  }
  if (raw === "codex") {
    return "codex";
  }
  console.error(`[pma] Invalid BUGRECALL_TOOLSET=${raw}; falling back to full`);
  return "full";
}

const activeToolset = resolveActiveToolset();
const codexToolNameSet = new Set<string>(codexToolNames);
const fullToolNameSet = new Set<string>(fullToolNames);

function isToolVisible(toolName: string): boolean {
  if (!fullToolNameSet.has(toolName)) return false;
  if (activeToolset === "full") {
    return true;
  }
  return codexToolNameSet.has(toolName);
}

function getVisibleToolCount(): number {
  return activeToolset === "codex" ? codexToolNames.length : fullToolNames.length;
}

const workspacePathField = {
  workspace_path: z.string().optional(),
};

const bootstrapProjectInputSchema = z.object(workspacePathField).strict();
const getProjectProfileInputSchema = z.object(workspacePathField).strict();

const readProjectMemoryInputSchema = z
  .object({
    ...workspacePathField,
    type: z.enum(memoryTypeValues).optional(),
    limit: z.number().int().min(1).max(100).optional().default(10),
  })
  .strict();

const commitPostmortemInputSchema = z
  .object({
    ...workspacePathField,
    type: z.enum(["incident", "fact", "decision"]).default("incident"),
    scope: z.enum(["workspace-only", "project-only", "repo-family"]).default("workspace-only"),
    content: z.string().min(1),
    confidence: z.number().min(0).max(1).default(0.8),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

const ingestTerminalErrorInputSchema = z
  .object({
    ...workspacePathField,
    raw_log: z.string().min(1),
    command_kind: z.enum(["test", "lint", "build", "typecheck", "run", "unknown"]).optional(),
    workspace: z.string().optional(),
    files: z.array(z.string()).optional(),
  })
  .strict();

const searchProjectExperienceInputSchema = z
  .object({
    ...workspacePathField,
    query: z.string().min(1),
    filters: z
      .object({
        type: z.enum(memoryTypeValues).optional(),
        workspace: z.string().optional(),
        toolchain: z.string().optional(),
        language: z.string().optional(),
        framework: z.string().optional(),
        error_class: z.string().optional(),
        min_confidence: z.number().min(0).max(1).optional(),
      })
      .optional(),
    limit: z.number().int().min(1).max(50).optional().default(5),
    mode: z.enum(["auto", "text", "vector", "hybrid"]).optional().default("auto"),
    detail_level: z.enum(["summary", "full"]).optional().default("summary"),
    include_warnings: z.boolean().optional().default(true),
    error_signature_id: z.string().optional(),
    error_signature_hash: z.string().optional(),
  })
  .strict();

const getMemoryDetailInputSchema = z
  .object({
    ...workspacePathField,
    memory_id: z.string().min(1),
  })
  .strict();

const recordUserCorrectionInputSchema = z
  .object({
    ...workspacePathField,
    correction_type: z.enum(["rejected_fix", "project_preference"]).optional().default("project_preference"),
    context: z.string().min(1),
    user_feedback: z.string().min(1),
    rejected_pattern: z.string().optional(),
    preferred_pattern: z.string().optional(),
    future_rule: z.string().min(1),
    applies_to: z
      .object({
        language: z.string().optional(),
        framework: z.string().optional(),
        toolchain: z.string().optional(),
        error_class: z.string().optional(),
        file_path: z.string().optional(),
        error_signature_id: z.string().optional(),
        error_signature_hash: z.string().optional(),
      })
      .optional(),
    confidence: z.number().min(0).max(1).optional().default(0.9),
  })
  .strict();

const listUserCorrectionsInputSchema = z
  .object({
    ...workspacePathField,
    limit: z.number().int().min(1).max(500).optional().default(50),
    correction_type: z.enum(["rejected_fix", "project_preference"]).optional(),
    language: z.string().optional(),
    framework: z.string().optional(),
    toolchain: z.string().optional(),
    error_class: z.string().optional(),
  })
  .strict();

const getRecurringErrorsInputSchema = z
  .object({
    ...workspacePathField,
    limit: z.number().int().min(1).max(200).optional().default(20),
    min_occurrences: z.number().int().min(1).max(1000).optional().default(2),
    language: z.string().optional(),
    toolchain: z.string().optional(),
    error_class: z.string().optional(),
  })
  .strict();

const vectorizePendingMemoriesInputSchema = z
  .object({
    ...workspacePathField,
    limit: z.number().int().min(1).max(50).optional().default(10),
    retry_failed: z.boolean().optional().default(false),
  })
  .strict();

const getVectorizationStatusInputSchema = z
  .object({
    ...workspacePathField,
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const indexReadyMemoriesInputSchema = z
  .object({
    ...workspacePathField,
    limit: z.number().int().min(1).max(500).optional().default(50),
    rebuild: z.boolean().optional().default(false),
  })
  .strict();

const applySearchReplacePatchInputSchema = z
  .object({
    ...workspacePathField,
    file_path: z.string().min(1),
    search_block: z.string().min(1),
    replace_block: z.string(),
    task_run_id: z.string().optional(),
  })
  .strict();

const restoreSnapshotInputSchema = z
  .object({
    ...workspacePathField,
    snapshot_id: z.string().min(1),
  })
  .strict();

const startTaskRunInputSchema = z
  .object({
    ...workspacePathField,
    task_text: z.string().min(1),
    approval_budget: z
      .object({
        max_total_command_runs: z.number().int().min(1).max(100).optional().default(5),
        max_test_runs: z.number().int().min(1).max(100).optional().default(5),
        max_lint_runs: z.number().int().min(1).max(100).optional().default(3),
        max_build_runs: z.number().int().min(1).max(100).optional().default(3),
        max_typecheck_runs: z.number().int().min(1).max(100).optional().default(3),
        timeout_ms: z.number().int().min(1000).max(300000).optional().default(30000),
      })
      .optional(),
  })
  .strict();

const getTaskRunInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
  })
  .strict();

const runProjectCommandInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
    kind: z.enum(["test", "lint", "build", "typecheck"]),
  })
  .strict();

const logAttemptInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
    kind: z.enum(["patch", "command", "reasoning", "memory"]),
    summary: z.string().min(1),
    success: z.boolean(),
    metadata: z.record(z.unknown()).optional().default({}),
  })
  .strict();

const createDebugSessionInputSchema = z
  .object({
    ...workspacePathField,
    task_text: z.string().min(1),
    initial_context: z.string().optional(),
    approval_budget: startTaskRunInputSchema.shape.approval_budget,
  })
  .strict();

const recordErrorObservationInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
    raw_output: z.string().min(1),
    command_kind: z.enum(["test", "lint", "build", "typecheck", "manual"]).optional(),
    context: z.record(z.unknown()).optional().default({}),
  })
  .strict();

const suggestNextActionsInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
    normalized_error: z.record(z.unknown()).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional().default(5),
  })
  .strict();

const finalizeSuccessfulFixInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
    summary: z.string().min(1),
    root_cause: z.string().min(1),
    fix_pattern: z.string().min(1),
    symptoms: z.array(z.string()).optional(),
    anti_patterns: z.array(z.string()).optional(),
    verification_steps: z.array(z.string()).optional(),
    files_changed: z.array(z.string()).optional(),
    error_class: z.string().optional(),
    language: z.string().optional(),
    toolchain: z.string().optional(),
    workspace: z.string().optional(),
    confidence: z.number().min(0).max(1).optional().default(0.9),
    error_signature_id: z.string().optional(),
    error_signature_hash: z.string().optional(),
  })
  .strict();

const failDebugSessionInputSchema = z
  .object({
    ...workspacePathField,
    task_run_id: z.string().min(1),
    reason: z.string().min(1),
    summary: z.string().optional(),
  })
  .strict();

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function detectGitRoot(cwd: string): string {
  const root = runGit(["rev-parse", "--show-toplevel"], cwd);
  return root ?? cwd;
}

const WORKSPACE_MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "uv.lock",
  "poetry.lock",
  "Cargo.toml",
  "go.mod",
] as const;

function listManifestFiles(root: string): string[] {
  return WORKSPACE_MANIFEST_FILES.filter((name) => existsSync(path.join(root, name)));
}

function findNearestManifestRoot(cwd: string, stopAt: string): string | null {
  let current = path.resolve(cwd);
  const stop = path.resolve(stopAt);
  while (true) {
    if (listManifestFiles(current).length > 0) return current;
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function detectRepoRoot(cwd: string): { repoRoot: string; detected: boolean } {
  const root = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root) return { repoRoot: cwd, detected: false };
  return { repoRoot: root, detected: true };
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class WorkspacePathResolutionError extends Error {
  constructor(
    public readonly reason:
      | "invalid_workspace_path"
      | "workspace_path_outside_repo"
      | "workspace_path_not_found"
      | "workspace_path_not_directory",
    public readonly workspace_path: string,
  ) {
    super(reason);
  }
}

async function resolveEffectiveWorkspaceCwd(baseCwd: string, workspacePath?: string): Promise<string> {
  if (!workspacePath) return baseCwd;
  const { repoRoot } = detectRepoRoot(baseCwd);
  const raw = workspacePath.trim();
  if (!raw) throw new WorkspacePathResolutionError("invalid_workspace_path", workspacePath);
  let resolved: string;
  try {
    resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
  } catch {
    throw new WorkspacePathResolutionError("invalid_workspace_path", workspacePath);
  }
  if (!isPathInside(repoRoot, resolved)) {
    throw new WorkspacePathResolutionError("workspace_path_outside_repo", workspacePath);
  }
  const info = await stat(resolved).catch(() => null);
  if (!info) throw new WorkspacePathResolutionError("workspace_path_not_found", workspacePath);
  if (!info.isDirectory()) throw new WorkspacePathResolutionError("workspace_path_not_directory", workspacePath);
  return resolved;
}

function detectWorkspaceRoot(cwd: string, repoRoot: string): string {
  return findNearestManifestRoot(cwd, repoRoot) ?? repoRoot;
}

function toPosixRelative(base: string, target: string): string {
  const rel = path.relative(base, target);
  if (!rel || rel === "") {
    return ".";
  }
  return rel.split(path.sep).join("/");
}

function getWorkspaceRelativePath(repoRoot: string, workspaceRoot: string): string {
  return toPosixRelative(repoRoot, workspaceRoot);
}

async function detectManifestFingerprint(workspaceRoot: string): Promise<string | null> {
  const manifestFiles = listManifestFiles(workspaceRoot);
  if (manifestFiles.length === 0) return null;
  const chunks: string[] = [];
  for (const fileName of manifestFiles) {
    const filePath = path.join(workspaceRoot, fileName);
    const content = await readFile(filePath, "utf8");
    chunks.push(`${fileName}:${sha256(content)}`);
  }
  return sha256(chunks.sort().join("|"));
}

function commandExists(command: string, cwd: string): boolean {
  try {
    const res = spawnSync(command, ["--version"], { cwd, stdio: "ignore" });
    return !res.error;
  } catch {
    return false;
  }
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`(^|[^a-z0-9_\\-])${escaped}([^a-z0-9_\\-]|$)`, "i");
    return rx.test(text);
  });
}

async function detectProfile(
  workspaceRoot: string,
  repoRootDetected: boolean,
  workspaceRelativePath: string,
): Promise<{ profile: ProjectProfile; warnings: string[] }> {
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const pyprojectPath = path.join(workspaceRoot, "pyproject.toml");
  const requirementsPath = path.join(workspaceRoot, "requirements.txt");
  const pnpmLockPath = path.join(workspaceRoot, "pnpm-lock.yaml");
  const yarnLockPath = path.join(workspaceRoot, "yarn.lock");
  const uvLockPath = path.join(workspaceRoot, "uv.lock");
  const poetryLockPath = path.join(workspaceRoot, "poetry.lock");
  const cargoTomlPath = path.join(workspaceRoot, "Cargo.toml");
  const goModPath = path.join(workspaceRoot, "go.mod");

  const workspaceManifestFiles = listManifestFiles(workspaceRoot);

  const languages = new Set<string>();
  const frameworks = new Set<string>();
  let packageManager: string | null = null;
  let testCommand: string | null = null;
  let lintCommand: string | null = null;
  let buildCommand: string | null = null;
  let typecheckCommand: string | null = null;
  const warnings: string[] = [];

  const hasScript = (scripts: Record<string, string>, name: string): boolean => {
    const raw = scripts[name];
    return typeof raw === "string" && raw.trim().length > 0;
  };

  if (existsSync(packageJsonPath)) {
    languages.add("javascript");
    languages.add("typescript");
    packageManager = "npm";
    if (existsSync(pnpmLockPath)) packageManager = "pnpm";
    if (existsSync(yarnLockPath)) packageManager = "yarn";

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    const deps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    const scripts = packageJson.scripts ?? {};

    if (deps.fastify || deps["@fastify/fastify"]) frameworks.add("fastify");
    if (deps.express) frameworks.add("express");
    if (deps.next) frameworks.add("nextjs");
    if (deps.react) frameworks.add("react");
    if (deps.vue) frameworks.add("vue");
    if (deps.svelte) frameworks.add("svelte");
    if (deps.nest || deps["@nestjs/core"]) frameworks.add("nestjs");

    if (packageManager === "pnpm") {
      testCommand = hasScript(scripts, "test") ? "pnpm run test" : "pnpm test";
      lintCommand = hasScript(scripts, "lint") ? "pnpm run lint" : null;
      buildCommand = hasScript(scripts, "build") ? "pnpm run build" : null;
      typecheckCommand = hasScript(scripts, "typecheck") ? "pnpm run typecheck" : null;
    } else if (packageManager === "yarn") {
      testCommand = hasScript(scripts, "test") ? "yarn test" : "yarn test";
      lintCommand = hasScript(scripts, "lint") ? "yarn lint" : null;
      buildCommand = hasScript(scripts, "build") ? "yarn build" : null;
      typecheckCommand = hasScript(scripts, "typecheck") ? "yarn typecheck" : null;
    } else {
      testCommand = hasScript(scripts, "test") ? "npm run test" : "npm test";
      lintCommand = hasScript(scripts, "lint") ? "npm run lint" : null;
      buildCommand = hasScript(scripts, "build") ? "npm run build" : null;
      typecheckCommand = hasScript(scripts, "typecheck") ? "npm run typecheck" : null;
    }
  }

  if (existsSync(pyprojectPath) || existsSync(requirementsPath)) {
    languages.add("python");
    const pythonCmd = commandExists("python", workspaceRoot) ? "python" : commandExists("python3", workspaceRoot) ? "python3" : null;
    if (!commandExists("python", workspaceRoot) && pythonCmd === "python3") {
      warnings.push("python_command_missing_using_python3");
    }

    const pyprojectText = existsSync(pyprojectPath) ? (await readFile(pyprojectPath, "utf8")).toLowerCase() : "";
    const requirementsText = existsSync(requirementsPath) ? (await readFile(requirementsPath, "utf8")).toLowerCase() : "";
    const setupCfgPath = path.join(workspaceRoot, "setup.cfg");
    const setupCfgText = existsSync(setupCfgPath) ? (await readFile(setupCfgPath, "utf8")).toLowerCase() : "";
    const requirementFiles = (await readdir(workspaceRoot)).filter((name) => /^requirements.*\.txt$/i.test(name));
    let pythonEvidenceText = "";

    if (pyprojectText) {
      pythonEvidenceText += `\n${pyprojectText}`;
      if (pyprojectText.includes("fastapi")) frameworks.add("fastapi");
      if (pyprojectText.includes("django")) frameworks.add("django");
      if (pyprojectText.includes("flask")) frameworks.add("flask");
      if (pyprojectText.includes("poetry")) packageManager = packageManager ?? "poetry";
    }
    if (requirementsText) {
      pythonEvidenceText += `\n${requirementsText}`;
    }
    for (const reqFile of requirementFiles) {
      const reqPath = path.join(workspaceRoot, reqFile);
      pythonEvidenceText += `\n${(await readFile(reqPath, "utf8")).toLowerCase()}`;
    }
    if (existsSync(uvLockPath)) packageManager = packageManager ?? "uv";
    if (existsSync(poetryLockPath)) packageManager = packageManager ?? "poetry";
    packageManager = packageManager ?? "pip";
    if (requirementFiles.length === 0 && !existsSync(requirementsPath)) {
      warnings.push("python_dependency_files_missing");
    }

    const pytestConfigured =
      hasAnyToken(pythonEvidenceText, ["pytest"]) ||
      pyprojectText.includes("[tool.pytest") ||
      existsSync(path.join(workspaceRoot, "pytest.ini")) ||
      existsSync(path.join(workspaceRoot, "tox.ini"));
    const mypyConfigured =
      hasAnyToken(pythonEvidenceText, ["mypy"]) ||
      pyprojectText.includes("[tool.mypy") ||
      existsSync(path.join(workspaceRoot, "mypy.ini")) ||
      setupCfgText.includes("[mypy");
    const ruffConfigured =
      hasAnyToken(pythonEvidenceText, ["ruff"]) ||
      pyprojectText.includes("[tool.ruff") ||
      existsSync(path.join(workspaceRoot, "ruff.toml"));
    const hasBuildSystem =
      pyprojectText.includes("[build-system]") ||
      existsSync(path.join(workspaceRoot, "setup.py")) ||
      existsSync(setupCfgPath);
    const buildModuleDeclared = hasAnyToken(pythonEvidenceText, ["build"]);

    if (pytestConfigured && pythonCmd) testCommand = testCommand ?? `${pythonCmd} -m pytest`;
    if (ruffConfigured && pythonCmd) lintCommand = lintCommand ?? `${pythonCmd} -m ruff check .`;
    if (mypyConfigured && pythonCmd) typecheckCommand = typecheckCommand ?? `${pythonCmd} -m mypy .`;
    if (hasBuildSystem && pythonCmd) buildCommand = buildCommand ?? `${pythonCmd} -m build`;

    if (!pytestConfigured) warnings.push("pytest_not_configured");
    if (!mypyConfigured) warnings.push("mypy_not_configured");
    if (!ruffConfigured) warnings.push("ruff_not_configured");
    if (!hasBuildSystem) warnings.push("python_build_not_configured");
    if (hasBuildSystem && !buildModuleDeclared) warnings.push("python_build_module_not_declared");
  }

  if (existsSync(cargoTomlPath)) {
    languages.add("rust");
    packageManager = packageManager ?? "cargo";
  }

  if (existsSync(goModPath)) {
    languages.add("go");
    packageManager = packageManager ?? "go";
  }

  return {
    profile: {
      languages: [...languages],
      frameworks: [...frameworks],
      package_manager: packageManager,
      test_command: testCommand,
      lint_command: lintCommand,
      build_command: buildCommand,
      typecheck_command: typecheckCommand,
      repo_root_detected: repoRootDetected,
      workspace_root_relative_path: workspaceRelativePath,
      workspace_manifest_files: workspaceManifestFiles,
    },
    warnings,
  };
}

async function isAgentIgnored(repoRoot: string): Promise<boolean> {
  const gitIgnorePath = path.join(repoRoot, ".gitignore");
  if (!existsSync(gitIgnorePath)) return false;
  const lines = (await readFile(gitIgnorePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return lines.includes(".agent") || lines.includes(".agent/");
}

export async function buildIdentityAndProfile(cwd: string, workspacePath?: string): Promise<{
  identity: ProjectIdentity;
  profile: ProjectProfile;
  warnings: string[];
  repoRoot: string;
  workspaceRoot: string;
  agentRoot: string;
}> {
  const effectiveCwd = await resolveEffectiveWorkspaceCwd(cwd, workspacePath);
  const repoResolution = detectRepoRoot(effectiveCwd);
  const repoRoot = repoResolution.repoRoot;
  const workspaceRoot = detectWorkspaceRoot(effectiveCwd, repoRoot);
  const workspaceRelativePath = getWorkspaceRelativePath(repoRoot, workspaceRoot);
  const remoteUrl = runGit(["remote", "get-url", "origin"], repoRoot);
  const gitRemoteHash = remoteUrl ? sha256(remoteUrl) : null;
  const initialCommitHash =
    runGit(["rev-list", "--max-parents=0", "HEAD"], repoRoot)?.split(/\s+/)[0] ?? null;
  const manifestFingerprint = await detectManifestFingerprint(workspaceRoot);
  const detectedProfile = await detectProfile(workspaceRoot, repoResolution.detected, workspaceRelativePath);
  const profile = detectedProfile.profile;

  const projectId = sha256(
    [
      gitRemoteHash ?? "no-remote",
      initialCommitHash ?? "no-initial-commit",
      workspaceRelativePath,
      manifestFingerprint ?? "no-manifest",
    ].join("|"),
  );

  const warnings: string[] = [];
  if (!(await isAgentIgnored(repoRoot))) {
    warnings.push(".agent/ is not listed in .gitignore");
  }
  warnings.push(...detectedProfile.warnings);

  return {
    identity: {
      project_id: projectId,
      git_remote_hash: gitRemoteHash,
      initial_commit_hash: initialCommitHash,
      workspace_relative_path: workspaceRelativePath,
      manifest_fingerprint: manifestFingerprint,
    },
    profile,
    warnings,
    repoRoot,
    workspaceRoot,
    agentRoot: repoRoot,
  };
}

export async function ensureStore(agentRoot: string): Promise<{ store: SqliteStore; dbPath: string; migrations: string[] }> {
  const agentDir = path.join(agentRoot, ".agent");
  const dbPath = path.join(agentDir, "memory.db");
  await mkdir(agentDir, { recursive: true });
  const store = new SqliteStore(dbPath);
  const migrations = store.runMigrations();
  return { store, dbPath, migrations };
}

function defaultTaskBudget(input?: Partial<TaskBudget>): TaskBudget {
  return {
    max_total_command_runs: input?.max_total_command_runs ?? 5,
    max_test_runs: input?.max_test_runs ?? 5,
    max_lint_runs: input?.max_lint_runs ?? 3,
    max_build_runs: input?.max_build_runs ?? 3,
    max_typecheck_runs: input?.max_typecheck_runs ?? 3,
    timeout_ms: input?.timeout_ms ?? 30000,
  };
}

function clampTail(input: string, maxChars = 4000): string {
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars);
}

function hasUnsafeShellTokens(command: string): boolean {
  return /(;|&&|\|\||\||>|<|`|\$\(|\n|\r)/.test(command);
}

function parseStructuredCommand(command: string): { ok: true; value: StructuredCommand } | { ok: false; reason: string } {
  const normalized = command.trim();
  if (!normalized) return { ok: false, reason: "command_not_configured" };
  if (hasUnsafeShellTokens(normalized)) return { ok: false, reason: "unsafe_command_profile" };
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "command_not_configured" };
  return {
    ok: true,
    value: {
      cmd: parts[0],
      args: parts.slice(1),
      cwd: ".",
      source: "project_profile",
    },
  };
}

function remainingBudget(budget: TaskBudget, usage: Record<string, number>): Record<string, number> {
  return {
    total: Math.max(0, budget.max_total_command_runs - Number(usage.total ?? 0)),
    test: Math.max(0, budget.max_test_runs - Number(usage.test ?? 0)),
    lint: Math.max(0, budget.max_lint_runs - Number(usage.lint ?? 0)),
    build: Math.max(0, budget.max_build_runs - Number(usage.build ?? 0)),
    typecheck: Math.max(0, budget.max_typecheck_runs - Number(usage.typecheck ?? 0)),
  };
}

function workflowSteps(): string[] {
  return [
    "record_error_observation",
    "search_project_experience",
    "apply_search_replace_patch",
    "run_project_command",
    "finalize_successful_fix",
  ];
}

function verifyTaskRunForProject(
  store: SqliteStore,
  taskRunId: string,
  projectId: string,
): { ok: true; taskRun: NonNullable<ReturnType<SqliteStore["getTaskRunById"]>> } | { ok: false; body: Record<string, unknown> } {
  const taskRun = store.getTaskRunById(taskRunId);
  if (!taskRun) return { ok: false, body: { ok: false, reason: "task_run_not_found", task_run_id: taskRunId } };
  if (taskRun.project_id !== projectId) {
    return { ok: false, body: { ok: false, reason: "task_run_project_mismatch", task_run_id: taskRunId } };
  }
  return { ok: true, taskRun };
}

function suggestedSearchQuery(normalized: ReturnType<typeof normalizeTerminalError>): string {
  return [normalized.error_class, normalized.detected_toolchain, normalized.detected_language, normalized.normalized_error]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

function deterministicActions(normalized?: Record<string, unknown>): string[] {
  const language = String(normalized?.detected_language ?? normalized?.language ?? "");
  const toolchain = String(normalized?.detected_toolchain ?? normalized?.toolchain ?? "");
  const actions = [
    "Inspect files mentioned in the traceback or compiler output.",
    "Check whether a previous fix pattern applies before editing.",
    "Apply a Search/Replace patch only with an exact unique block.",
  ];
  if (language === "typescript" || toolchain === "tsc" || toolchain === "nextjs") {
    actions.push("Run typecheck after editing TypeScript files.");
  }
  if (toolchain === "pytest" || language === "python") {
    actions.push("Run test after editing backend logic.");
  }
  actions.push("Finalize the fix only after verification passes.");
  return actions;
}

function commandRecommendation(normalized?: Record<string, unknown>): string | null {
  const language = String(normalized?.detected_language ?? normalized?.language ?? "");
  const toolchain = String(normalized?.detected_toolchain ?? normalized?.toolchain ?? "");
  if (toolchain === "eslint") return "lint";
  if (toolchain === "tsc" || toolchain === "nextjs" || language === "typescript") return "typecheck";
  if (toolchain === "pytest" || language === "python") return "test";
  return null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function mapSignatureForOutput(signature: ErrorSignatureRow): Record<string, unknown> {
  return {
    id: signature.id,
    signature_hash: signature.signature_hash,
    occurrence_count: signature.occurrence_count,
    is_recurring: signature.occurrence_count > 1,
    linked_memory_id: signature.linked_memory_id,
    first_seen_at: signature.first_seen_at,
    last_seen_at: signature.last_seen_at,
  };
}

function upsertNormalizedErrorSignature(params: {
  store: SqliteStore;
  identity: ProjectIdentity;
  profile: ProjectProfile;
  normalized: ReturnType<typeof normalizeTerminalError>;
  commandKind?: string;
  taskRunId?: string;
  rawLog?: string;
}): { signature: ErrorSignatureRow; occurrenceId: string; fields: ReturnType<typeof extractSignatureFields> } {
  const fields = extractSignatureFields(params.normalized, params.identity, params.profile, {
    commandKind: params.commandKind,
  });
  const signature = params.store.upsertErrorSignature({
    project_id: params.identity.project_id,
    workspace_relative_path: params.identity.workspace_relative_path,
    signature_hash: fields.signature_hash,
    language: fields.language,
    toolchain: fields.toolchain,
    error_class: fields.error_class,
    normalized_message: fields.normalized_message,
    top_frame_symbol: fields.top_frame_symbol,
    file_hint: fields.file_hint,
    command_kind: fields.command_kind,
    last_observation_json: {
      normalized_error: params.normalized.normalized_error,
      error_class: params.normalized.error_class,
      detected_language: params.normalized.detected_language,
      detected_toolchain: params.normalized.detected_toolchain,
      detected_files: params.normalized.detected_files,
      confidence: params.normalized.confidence,
    },
  });
  const occurrenceId = params.store.insertErrorOccurrence({
    signature_id: signature.id,
    project_id: params.identity.project_id,
    task_run_id: params.taskRunId ?? null,
    command_kind: params.commandKind ?? null,
    normalized_error_json: params.normalized,
    raw_log_hash: params.rawLog ? sha256Hex(params.rawLog) : null,
  });
  return { signature, occurrenceId, fields };
}

async function runStructuredCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exit_code: number | null; signal: string | null; stdout: string; stderr: string; duration_ms: number }> {
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let timeoutHit = false;
    const timer = setTimeout(() => {
      timeoutHit = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: timeoutHit ? null : code,
        signal: timeoutHit ? "SIGKILL" : signal,
        stdout,
        stderr,
        duration_ms: Date.now() - t0,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exit_code: null,
        signal: "SPAWN_ERROR",
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        duration_ms: Date.now() - t0,
      });
    });
  });
}

async function bootstrapProject(cwd: string, workspace_path?: string): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, workspace_path);
  const { store, migrations } = await ensureStore(data.agentRoot);
  try {
    store.upsertProject(data.identity);
    store.upsertProjectProfile(data.identity.project_id, data.profile);
  } finally {
    store.close();
  }

  return {
    ok: true,
    tool: "bootstrap_project",
    identity: data.identity,
    profile: data.profile,
    sqlite_file: ".agent/memory.db",
    migrations_applied: migrations,
    warnings: data.warnings,
  };
}

async function getProjectProfile(cwd: string, workspace_path?: string): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, workspace_path);
  return {
    ok: true,
    tool: "get_project_profile",
    identity: data.identity,
    profile: data.profile,
    warnings: data.warnings,
  };
}

async function commitPostmortem(cwd: string, input: CommitPostmortemInput & { workspace_path?: string }): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    store.upsertProject(data.identity);
    store.upsertProjectProfile(data.identity.project_id, data.profile);
    const metadata = { ...input.metadata };
    const summary = buildMemorySummaryForType(input.type, input.content, metadata);
    if (summary) metadata.summary = summary;
    const inserted = store.insertMemoryRecord(data.identity.project_id, { ...input, metadata, summary });
    return {
      ok: true,
      tool: "commit_postmortem",
      project_id: data.identity.project_id,
      record_id: inserted.id,
      status: inserted.status,
    };
  } finally {
    store.close();
  }
}

async function readProjectMemory(
  cwd: string,
  input: { type?: MemoryType; limit: number; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const records = store.readProjectMemory(data.identity.project_id, input.type, input.limit);
    return {
      ok: true,
      tool: "read_project_memory",
      project_id: data.identity.project_id,
      count: records.length,
      records,
    };
  } finally {
    store.close();
  }
}

async function ingestTerminalError(
  cwd: string,
  input: { raw_log: string; command_kind?: CommandKind; workspace?: string; files?: string[]; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  const normalized = normalizeTerminalError(input.raw_log, {
    command_kind: input.command_kind ?? "unknown",
    workspace: input.workspace,
    files: input.files,
  });
  try {
    const tracked = upsertNormalizedErrorSignature({
      store,
      identity: data.identity,
      profile: data.profile,
      normalized,
      commandKind: input.command_kind ?? "unknown",
      rawLog: input.raw_log,
    });
    return {
      ok: true,
      tool: "ingest_terminal_error",
      project_id: data.identity.project_id,
      normalized_error: normalized,
      error_signature: mapSignatureForOutput(tracked.signature),
      occurrence_id: tracked.occurrenceId,
      metadata: {
        ...normalized.metadata,
        workspace: input.workspace ?? data.identity.workspace_relative_path,
        memory_written: false,
      },
    };
  } finally {
    store.close();
  }
}

export async function searchProjectExperience(
  cwd: string,
  input: {
    query: string;
    filters?: SearchExperienceFilters;
    limit: number;
    mode: "auto" | "text" | "vector" | "hybrid";
    workspace_path?: string;
    detail_level?: "summary" | "full";
    include_warnings?: boolean;
    error_signature_id?: string;
    error_signature_hash?: string;
  },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  const config = getEmbeddingConfig();
  const embeddingClient = getEmbeddingClient();
  try {
    let queryVector: number[] | null = null;
    if (input.mode !== "text" && config.embeddings_enabled) {
      try {
        const embedded = await embeddingClient.embed("query", input.query, config.model, config.timeout_ms);
        queryVector = embedded.vector;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[search] query embedding failed: ${message}`);
      }
    }

    const hybrid = await runHybridSearch({
      projectRoot: data.repoRoot,
      projectId: data.identity.project_id,
      query: input.query,
      filters: input.filters ?? {},
      limit: input.limit,
      mode: input.mode,
      queryVector,
      store,
    });
    const detailLevel = input.detail_level ?? "summary";
    const includeWarnings = input.include_warnings ?? true;
    const signatureLookup = {
      requested: Boolean(input.error_signature_id || input.error_signature_hash),
      found: false,
      linked_memory_found: false,
    };
    let linkedMemoryId: string | null = null;
    let linkedSignatureHash: string | null = input.error_signature_hash ?? null;
    if (input.error_signature_id) {
      const sig = store.getErrorSignatureById(input.error_signature_id);
      if (sig && sig.project_id !== data.identity.project_id) {
        return { ok: false, reason: "error_signature_project_mismatch", error_signature_id: input.error_signature_id };
      }
      if (sig) {
        signatureLookup.found = true;
        linkedMemoryId = sig.linked_memory_id;
        linkedSignatureHash = sig.signature_hash;
      }
    } else if (input.error_signature_hash) {
      const sig = store.getErrorSignatureByHash(data.identity.project_id, input.error_signature_hash);
      if (sig) {
        signatureLookup.found = true;
        linkedMemoryId = sig.linked_memory_id;
        linkedSignatureHash = sig.signature_hash;
      }
    }
    if (linkedMemoryId) signatureLookup.linked_memory_found = true;
    const retrievalLevelBase =
      hybrid.mode_used === "hybrid"
        ? "hybrid"
        : hybrid.mode_used === "vector"
          ? "vector"
          : hybrid.mode_used === "text"
            ? "text"
            : "fallback";

    const candidates = hybrid.results
      .map((row) => {
        const summary = String((row.metadata?.summary as string | undefined) ?? row.summary ?? row.content ?? "").trim();
        return {
          ...row,
          summary: summary || row.content,
          retrieval_level: linkedMemoryId && row.id === linkedMemoryId ? "signature_linked_memory" : retrievalLevelBase,
          detail_available: true,
          metadata_preview: {
            error_class: row.metadata?.error_class ?? null,
            toolchain: row.metadata?.toolchain ?? null,
            language: row.metadata?.language ?? null,
            framework: row.metadata?.framework ?? null,
            workspace: row.metadata?.workspace ?? null,
          },
        };
      })
      .filter((row) => row.type !== "rejected_fix" && row.type !== "project_preference");

    if (linkedMemoryId && !candidates.some((row) => row.id === linkedMemoryId)) {
      const linked = store.getMemoryRecordById(data.identity.project_id, linkedMemoryId);
      if (linked && linked.type !== "rejected_fix" && linked.type !== "project_preference") {
        candidates.unshift({
          ...linked,
          score: 1,
          reason: "signature_linked_memory",
          retrieval_level: "signature_linked_memory",
          detail_available: true,
          metadata_preview: {
            error_class: linked.metadata?.error_class ?? null,
            toolchain: linked.metadata?.toolchain ?? null,
            language: linked.metadata?.language ?? null,
            framework: linked.metadata?.framework ?? null,
            workspace: linked.metadata?.workspace ?? null,
          },
        });
      }
    }

    const context: RankingContext = {
      query: input.query,
      filters: input.filters as Record<string, unknown> | undefined,
      project_id: data.identity.project_id,
      workspace_relative_path: data.identity.workspace_relative_path,
      requested_error_signature: signatureLookup.requested,
      requested_error_signature_id: input.error_signature_id ?? null,
      requested_error_signature_hash: linkedSignatureHash,
      linked_memory_id: linkedMemoryId,
      language:
        input.filters?.language ??
        (typeof data.profile.languages?.[0] === "string" ? data.profile.languages[0] : null) ??
        null,
      toolchain: input.filters?.toolchain ?? null,
      framework: input.filters?.framework ?? null,
      error_class: input.filters?.error_class ?? null,
    };
    const ranked = rankSearchResults({ context, results: candidates });
    const topRanked = ranked.slice(0, input.limit);
    store.markRecordsRetrieved(topRanked.map((row) => row.id));
    const corrections = store.listUserCorrections(
      data.identity.project_id,
      {
        language: input.filters?.language,
        toolchain: input.filters?.toolchain,
        error_class: input.filters?.error_class,
      },
      100,
    );
    const warnings = buildCorrectionWarnings(
      corrections,
      {
        query: input.query,
        language: input.filters?.language,
        toolchain: input.filters?.toolchain,
        error_class: input.filters?.error_class,
      },
    );
    const rankedWarnings = rankWarnings({ context, warnings });
    return {
      ok: true,
      tool: "search_project_experience",
      project_id: data.identity.project_id,
      query: input.query,
      mode_requested: input.mode,
      mode_used: hybrid.mode_used,
      vector_search_enabled: hybrid.vector_search_enabled,
      vector_store_status: hybrid.vector_store_status,
      note: hybrid.note,
      count: topRanked.length,
      signature_lookup: signatureLookup,
      results: topRanked.map((row) => ({
        ...row,
        detail_available: true,
        metadata_preview: {
          error_class: row.metadata?.error_class ?? null,
          toolchain: row.metadata?.toolchain ?? null,
          language: row.metadata?.language ?? null,
          framework: row.metadata?.framework ?? null,
          workspace: row.metadata?.workspace ?? null,
        },
        content: detailLevel === "summary" ? row.summary : row.content,
        metadata: detailLevel === "summary" ? {} : row.metadata,
      })),
      warnings: includeWarnings
        ? rankedWarnings.map((warning) => ({
            ...warning,
            summary: String(warning.future_rule ?? warning.preferred_pattern ?? warning.rejected_pattern ?? "").trim(),
            detail_available: true,
          }))
        : [],
    };
  } finally {
    store.close();
  }
}

export async function recordUserCorrection(
  cwd: string,
  input: z.infer<typeof recordUserCorrectionInputSchema>,
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const appliesTo = { ...(input.applies_to ?? {}) } as Record<string, unknown>;
    if (typeof appliesTo.file_path === "string") {
      const safe = resolveWorkspacePathSafely(data.workspaceRoot, appliesTo.file_path);
      if (!safe.ok) return { ok: false, reason: safe.reason, file_path: appliesTo.file_path };
    }
    if (typeof appliesTo.error_signature_id === "string") {
      const sig = store.getErrorSignatureById(appliesTo.error_signature_id);
      if (!sig) return { ok: false, reason: "error_signature_not_found", error_signature_id: appliesTo.error_signature_id };
      if (sig.project_id !== data.identity.project_id) {
        return { ok: false, reason: "error_signature_project_mismatch", error_signature_id: appliesTo.error_signature_id };
      }
      appliesTo.error_signature_hash = sig.signature_hash;
    }
    if (typeof appliesTo.error_signature_hash === "string") {
      const sigByHash = store.getErrorSignatureByHash(data.identity.project_id, appliesTo.error_signature_hash);
      if (sigByHash) appliesTo.error_signature_id = sigByHash.id;
    }
    const summary = buildMemorySummaryForType(
      input.correction_type,
      input.user_feedback,
      {
        future_rule: input.future_rule,
        rejected_pattern: input.rejected_pattern ?? null,
        preferred_pattern: input.preferred_pattern ?? null,
      },
    );
    const inserted = store.insertMemoryRecord(data.identity.project_id, {
      type: input.correction_type,
      scope: "workspace-only",
      content: input.user_feedback,
      confidence: input.confidence,
      summary,
      metadata: {
        source: "user_correction",
        context: input.context,
        user_feedback: input.user_feedback,
        rejected_pattern: input.rejected_pattern ?? null,
        preferred_pattern: input.preferred_pattern ?? null,
        future_rule: input.future_rule,
        applies_to: appliesTo,
        confidence: input.confidence,
        created_by: "user",
        verification_status: "user_preference_not_test_verified",
        summary,
      },
    });
    return {
      ok: true,
      tool: "record_user_correction",
      project_id: data.identity.project_id,
      workspace_relative_path: data.identity.workspace_relative_path,
      memory_id: inserted.id,
      memory_type: input.correction_type,
      summary,
      applies_to: appliesTo,
      metadata: {
        verification_status: "user_preference_not_test_verified",
      },
    };
  } finally {
    store.close();
  }
}

export async function listUserCorrections(
  cwd: string,
  input: z.infer<typeof listUserCorrectionsInputSchema>,
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const corrections = store.listUserCorrections(
      data.identity.project_id,
      {
        correction_type: input.correction_type,
        language: input.language,
        framework: input.framework,
        toolchain: input.toolchain,
        error_class: input.error_class,
      },
      input.limit,
    );
    return {
      ok: true,
      tool: "list_user_corrections",
      project_id: data.identity.project_id,
      workspace_relative_path: data.identity.workspace_relative_path,
      corrections: corrections.map((row) => ({
        id: row.id,
        type: row.type,
        content: row.content,
        summary: row.summary || (row.metadata.summary as string | undefined) || row.content,
        rejected_pattern: row.metadata.rejected_pattern ?? null,
        preferred_pattern: row.metadata.preferred_pattern ?? null,
        future_rule: row.metadata.future_rule ?? row.content,
        applies_to: row.metadata.applies_to ?? {},
        confidence: row.confidence,
        created_at: row.created_at,
        retrieval_hits: row.retrieval_hits,
        last_retrieved_at: row.last_retrieved_at,
      })),
    };
  } finally {
    store.close();
  }
}

export async function getMemoryDetail(
  cwd: string,
  input: z.infer<typeof getMemoryDetailInputSchema>,
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const row = store.getMemoryRecordById(data.identity.project_id, input.memory_id);
    if (row) {
      const linkedSignature = store.getErrorSignatureByLinkedMemoryId(data.identity.project_id, row.id);
      return {
        ok: true,
        tool: "get_memory_detail",
        project_id: data.identity.project_id,
        workspace_relative_path: data.identity.workspace_relative_path,
        memory: row,
        linked_error_signature: linkedSignature
          ? {
              id: linkedSignature.id,
              signature_hash: linkedSignature.signature_hash,
              error_class: linkedSignature.error_class,
              language: linkedSignature.language,
              toolchain: linkedSignature.toolchain,
              normalized_message: linkedSignature.normalized_message,
              occurrence_count: linkedSignature.occurrence_count,
              first_seen_at: linkedSignature.first_seen_at,
              last_seen_at: linkedSignature.last_seen_at,
            }
          : undefined,
      };
    }
    const anyProject = store.getMemoryRecordByIdAnyProject(input.memory_id);
    if (anyProject && anyProject.project_id !== data.identity.project_id) {
      return { ok: false, reason: "memory_project_mismatch", memory_id: input.memory_id };
    }
    return { ok: false, reason: "memory_not_found", memory_id: input.memory_id };
  } finally {
    store.close();
  }
}

export async function indexReadyMemories(
  cwd: string,
  input: { limit: number; rebuild: boolean; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const vectorStatus = await getVectorStoreStatus();
    if (vectorStatus.state !== "available") {
      return {
        ok: true,
        tool: "index_ready_memories",
        project_id: data.identity.project_id,
        indexed_count: 0,
        skipped_count: 0,
        failed_count: 0,
        vector_search_enabled: false,
        vector_store_status: vectorStatus,
      };
    }

    if (input.rebuild) {
      const ensured = await clearVectorProject(data.repoRoot, data.identity.project_id);
      if (!ensured.ok) {
        return {
          ok: true,
          tool: "index_ready_memories",
          project_id: data.identity.project_id,
          indexed_count: 0,
          skipped_count: 0,
          failed_count: 0,
          vector_search_enabled: false,
          vector_store_status: ensured.status,
          note: ensured.reason,
        };
      }
    }

    const ready = store.listReadyRecordsWithEmbeddings(data.identity.project_id, input.limit);
    const rows = ready.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      type: row.type,
      workspace: typeof row.metadata.workspace === "string" ? row.metadata.workspace : null,
      toolchain: typeof row.metadata.toolchain === "string" ? row.metadata.toolchain : null,
      language: typeof row.metadata.language === "string" ? row.metadata.language : null,
      error_class: typeof row.metadata.error_class === "string" ? row.metadata.error_class : null,
      model: row.model,
      dimension: row.dimension,
      vector: Array.from(row.vector),
    }));

    const result = await upsertVectors(data.repoRoot, rows);
    return {
      ok: true,
      tool: "index_ready_memories",
      project_id: data.identity.project_id,
      indexed_count: result.indexed_count,
      skipped_count: Math.max(0, ready.length - result.indexed_count - result.failed_count),
      failed_count: result.failed_count,
      vector_search_enabled: result.status.state === "available",
      vector_store_status: result.status,
      note: result.reason,
    };
  } finally {
    store.close();
  }
}

function resolveWorkspacePathSafely(workspaceRoot: string, filePath: string): { ok: true; fullPath: string } | { ok: false; reason: string } {
  if (path.isAbsolute(filePath)) return { ok: false, reason: "absolute_path_rejected" };
  const normalizedInput = filePath.replace(/\\/g, "/");
  if (normalizedInput.startsWith("../") || normalizedInput.includes("/../") || normalizedInput === "..") {
    return { ok: false, reason: "path_traversal_rejected" };
  }
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "path_traversal_rejected" };
  }
  return { ok: true, fullPath: resolved };
}

function normalizeLower(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function shortText(value: unknown, max = 280): string {
  const clean = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function buildMemorySummaryForType(
  type: "incident" | "fact" | "decision" | "rejected_fix" | "project_preference",
  content: string,
  metadata: Record<string, unknown>,
): string {
  if (type === "rejected_fix") {
    const rejected = shortText(metadata.rejected_pattern);
    const preferred = shortText(metadata.preferred_pattern);
    const rule = shortText(metadata.future_rule || metadata.summary || content);
    const parts = [rule];
    if (rejected) parts.push(`Reject: ${rejected}`);
    if (preferred) parts.push(`Prefer: ${preferred}`);
    return shortText(parts.join(" "));
  }
  if (type === "project_preference") {
    return shortText(metadata.future_rule || metadata.summary || content);
  }
  const errorClass = shortText(metadata.error_class);
  const rootCause = shortText(metadata.root_cause);
  const fixPattern = shortText(metadata.fix_pattern);
  const antiPattern = shortText(Array.isArray(metadata.anti_patterns) ? metadata.anti_patterns.join(", ") : metadata.anti_patterns);
  const parts: string[] = [];
  if (errorClass) parts.push(`[${errorClass}]`);
  if (rootCause) parts.push(`Root cause: ${rootCause}`);
  if (fixPattern) parts.push(`Fix: ${fixPattern}`);
  if (antiPattern) parts.push(`Avoid: ${antiPattern}`);
  if (parts.length === 0) return shortText(metadata.summary || content);
  return shortText(parts.join(" "));
}

function buildCorrectionWarnings(
  corrections: Array<{
    id: string;
    type: string;
    confidence: number;
    metadata: Record<string, unknown>;
  }>,
  input: {
    query: string;
    toolchain?: string;
    language?: string;
    error_class?: string;
  },
): Array<Record<string, unknown>> {
  const q = normalizeLower(input.query);
  return corrections
    .map((row) => {
      const applies = (row.metadata.applies_to as Record<string, unknown> | undefined) ?? {};
      const rejectedPattern = String(row.metadata.rejected_pattern ?? "");
      const preferredPattern = String(row.metadata.preferred_pattern ?? "");
      const futureRule = String(row.metadata.future_rule ?? "");
      let score = 0;
      let reason = "general_preference";
      if (rejectedPattern && q.includes(normalizeLower(rejectedPattern))) {
        score += 4;
        reason = "query_matches_rejected_pattern";
      }
      if (input.error_class && normalizeLower(applies.error_class) === normalizeLower(input.error_class)) {
        score += 3;
        reason = "matching_error_class";
      }
      if (input.toolchain && normalizeLower(applies.toolchain) === normalizeLower(input.toolchain)) {
        score += 2;
        reason = "matching_toolchain";
      }
      if (input.language && normalizeLower(applies.language) === normalizeLower(input.language)) {
        score += 2;
        reason = "matching_language";
      }
      if (score === 0 && row.type === "project_preference") score = 1;
      return {
        memory_id: row.id,
        type: row.type,
        reason,
        rejected_pattern: rejectedPattern || null,
        preferred_pattern: preferredPattern || null,
        future_rule: futureRule || null,
        confidence: row.confidence,
        score,
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ score: _score, ...rest }) => rest);
}

function countExactOccurrences(content: string, searchBlock: string): number {
  if (searchBlock.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = content.indexOf(searchBlock, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + searchBlock.length;
  }
  return count;
}

function applyExactReplacement(content: string, searchBlock: string, replaceBlock: string): string {
  const idx = content.indexOf(searchBlock);
  if (idx < 0) return content;
  return `${content.slice(0, idx)}${replaceBlock}${content.slice(idx + searchBlock.length)}`;
}

function compressSnapshot(content: string): Buffer {
  return gzipSync(Buffer.from(content, "utf8"));
}

function decompressSnapshot(compression: "gzip" | "brotli", blob: Buffer): string {
  if (compression === "gzip") return gunzipSync(blob).toString("utf8");
  throw new Error(`Unsupported compression: ${compression}`);
}

async function applySearchReplacePatch(
  cwd: string,
  input: { file_path: string; search_block: string; replace_block: string; task_run_id?: string; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const safePath = resolveWorkspacePathSafely(data.workspaceRoot, input.file_path);
    if (!safePath.ok) {
      const patchId = store.insertPatchHistory({
        task_run_id: input.task_run_id ?? `local-${randomUUID()}`,
        project_id: data.identity.project_id,
        file_path: input.file_path,
        search_block: input.search_block,
        replace_block: input.replace_block,
        match_count: 0,
        success_flag: 0,
        reason: safePath.reason,
      });
      return {
        success: false,
        file_path: input.file_path,
        match_count: 0,
        reason: safePath.reason,
        patch_history_id: patchId,
      };
    }

    const fileStat = await stat(safePath.fullPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      const patchId = store.insertPatchHistory({
        task_run_id: input.task_run_id ?? `local-${randomUUID()}`,
        project_id: data.identity.project_id,
        file_path: input.file_path,
        search_block: input.search_block,
        replace_block: input.replace_block,
        match_count: 0,
        success_flag: 0,
        reason: "file_not_found_or_not_regular",
      });
      return {
        success: false,
        file_path: input.file_path,
        match_count: 0,
        reason: "file_not_found_or_not_regular",
        patch_history_id: patchId,
      };
    }

    const content = await readFile(safePath.fullPath, "utf8");
    const matchCount = countExactOccurrences(content, input.search_block);
    if (matchCount === 0) {
      const patchId = store.insertPatchHistory({
        task_run_id: input.task_run_id ?? `local-${randomUUID()}`,
        project_id: data.identity.project_id,
        file_path: input.file_path,
        search_block: input.search_block,
        replace_block: input.replace_block,
        match_count: 0,
        success_flag: 0,
        reason: "no_exact_match",
      });
      return {
        success: false,
        file_path: input.file_path,
        match_count: 0,
        reason: "no_exact_match",
        patch_history_id: patchId,
      };
    }
    if (matchCount > 1) {
      const patchId = store.insertPatchHistory({
        task_run_id: input.task_run_id ?? `local-${randomUUID()}`,
        project_id: data.identity.project_id,
        file_path: input.file_path,
        search_block: input.search_block,
        replace_block: input.replace_block,
        match_count: matchCount,
        success_flag: 0,
        reason: "multiple_matches",
      });
      return {
        success: false,
        file_path: input.file_path,
        match_count: matchCount,
        reason: "multiple_matches",
        guidance: "Use a larger surrounding context in search_block",
        patch_history_id: patchId,
      };
    }

    const taskRunId = input.task_run_id ?? `local-${randomUUID()}`;
    const snapshotId = store.insertSnapshot({
      task_run_id: taskRunId,
      project_id: data.identity.project_id,
      workspace_relative_path: data.identity.workspace_relative_path,
      file_path: input.file_path,
      content_blob: compressSnapshot(content),
      compression: "gzip",
    });
    const replaced = applyExactReplacement(content, input.search_block, input.replace_block);
    await writeFile(safePath.fullPath, replaced, "utf8");
    const patchId = store.insertPatchHistory({
      task_run_id: taskRunId,
      project_id: data.identity.project_id,
      file_path: input.file_path,
      search_block: input.search_block,
      replace_block: input.replace_block,
      match_count: 1,
      success_flag: 1,
      reason: "applied",
    });
    return {
      success: true,
      file_path: input.file_path,
      match_count: 1,
      reason: "applied",
      patch_history_id: patchId,
      snapshot_id: snapshotId,
    };
  } finally {
    store.close();
  }
}

async function restoreSnapshot(cwd: string, input: { snapshot_id: string; workspace_path?: string }): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const snapshot = store.getSnapshotById(input.snapshot_id);
    if (!snapshot) {
      return { success: false, reason: "snapshot_not_found", snapshot_id: input.snapshot_id };
    }
    if (!snapshot.project_id) {
      return {
        success: false,
        reason: "legacy_snapshot_missing_project_id",
        snapshot_id: input.snapshot_id,
        file_path: snapshot.file_path,
      };
    }
    if (snapshot.project_id !== data.identity.project_id) {
      return {
        success: false,
        reason: "snapshot_project_mismatch",
        snapshot_id: input.snapshot_id,
        file_path: snapshot.file_path,
      };
    }
    const safePath = resolveWorkspacePathSafely(data.workspaceRoot, snapshot.file_path);
    if (!safePath.ok) {
      return { success: false, reason: safePath.reason, snapshot_id: input.snapshot_id, file_path: snapshot.file_path };
    }
    const restored = decompressSnapshot(snapshot.compression, snapshot.content_blob);
    await writeFile(safePath.fullPath, restored, "utf8");
    return {
      success: true,
      snapshot_id: input.snapshot_id,
      file_path: snapshot.file_path,
      reason: "restored",
    };
  } finally {
    store.close();
  }
}

async function startTaskRun(
  cwd: string,
  input: { task_text: string; approval_budget?: Partial<TaskBudget>; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const budget = defaultTaskBudget(input.approval_budget);
    const created = store.startTaskRun(data.identity.project_id, input.task_text, budget, randomUUID());
    return {
      ok: true,
      tool: "start_task_run",
      task_run_id: created.id,
      project_id: created.project_id,
      budget: created.approval_budget,
      status: created.status,
    };
  } finally {
    store.close();
  }
}

async function getTaskRun(cwd: string, input: { task_run_id: string; workspace_path?: string }): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const row = store.getTaskRunById(input.task_run_id);
    if (!row) return { ok: false, reason: "task_run_not_found", task_run_id: input.task_run_id };
    if (row.project_id !== data.identity.project_id) {
      return { ok: false, reason: "task_run_project_mismatch", task_run_id: input.task_run_id };
    }
    const usage = store.getTaskRunCommandUsage(input.task_run_id);
    return {
      ok: true,
      tool: "get_task_run",
      id: row.id,
      project_id: row.project_id,
      session_id: row.session_id,
      task_text: row.task_text,
      status: row.status,
      approval_budget: row.approval_budget,
      command_usage: usage,
      started_at: row.started_at,
      ended_at: row.ended_at,
      summary: row.summary,
    };
  } finally {
    store.close();
  }
}

async function logAttempt(
  cwd: string,
  input: { task_run_id: string; kind: "patch" | "command" | "reasoning" | "memory"; summary: string; success: boolean; metadata?: Record<string, unknown>; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const row = store.getTaskRunById(input.task_run_id);
    if (!row) return { ok: false, reason: "task_run_not_found", task_run_id: input.task_run_id };
    if (row.project_id !== data.identity.project_id) {
      return { ok: false, reason: "task_run_project_mismatch", task_run_id: input.task_run_id };
    }
    const attemptId = store.insertTaskAttempt({
      task_run_id: input.task_run_id,
      project_id: data.identity.project_id,
      kind: input.kind,
      summary: input.summary,
      success: input.success,
      metadata: input.metadata ?? {},
    });
    return { ok: true, tool: "log_attempt", attempt_id: attemptId };
  } finally {
    store.close();
  }
}

async function runProjectCommand(
  cwd: string,
  input: { task_run_id: string; kind: "test" | "lint" | "build" | "typecheck"; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const taskRun = store.getTaskRunById(input.task_run_id);
    if (!taskRun) return { ok: false, reason: "task_run_not_found", task_run_id: input.task_run_id };
    if (taskRun.project_id !== data.identity.project_id) {
      return { ok: false, reason: "task_run_project_mismatch", task_run_id: input.task_run_id };
    }

    const usage = store.getTaskRunCommandUsage(input.task_run_id);
    const budget = taskRun.approval_budget;
    const budgetLeft = remainingBudget(budget, usage);
    const kindRemaining = Number(budgetLeft[input.kind] ?? 0);
    if (budgetLeft.total <= 0 || kindRemaining <= 0) {
      const attemptId = store.insertTaskAttempt({
        task_run_id: input.task_run_id,
        project_id: data.identity.project_id,
        kind: "command",
        summary: `blocked ${input.kind}: budget exceeded`,
        success: false,
        metadata: { command_kind: input.kind, reason: "budget_exceeded" },
      });
      return {
        ok: false,
        reason: "budget_exceeded",
        attempt_id: attemptId,
        budget_remaining: budgetLeft,
      };
    }

    const commandStr = store.getProjectCommandString(data.identity.project_id, input.kind);
    if (!commandStr) {
      const attemptId = store.insertTaskAttempt({
        task_run_id: input.task_run_id,
        project_id: data.identity.project_id,
        kind: "command",
        summary: `missing ${input.kind} command`,
        success: false,
        metadata: { command_kind: input.kind, reason: "command_not_configured" },
      });
      return {
        ok: false,
        reason: "command_not_configured",
        kind: input.kind,
        project_id: data.identity.project_id,
        workspace_relative_path: data.identity.workspace_relative_path,
        attempt_id: attemptId,
        budget_remaining: remainingBudget(budget, store.getTaskRunCommandUsage(input.task_run_id)),
      };
    }

    const parsedCommand = parseStructuredCommand(commandStr);
    if (!parsedCommand.ok) {
      const attemptId = store.insertTaskAttempt({
        task_run_id: input.task_run_id,
        project_id: data.identity.project_id,
        kind: "command",
        summary: `unsafe ${input.kind} command profile`,
        success: false,
        metadata: { command_kind: input.kind, reason: parsedCommand.reason, command: commandStr },
      });
      return {
        ok: false,
        reason: parsedCommand.reason,
        attempt_id: attemptId,
        budget_remaining: remainingBudget(budget, store.getTaskRunCommandUsage(input.task_run_id)),
      };
    }

    const command = parsedCommand.value;
    const runResult = await runStructuredCommand(command.cmd, command.args, data.workspaceRoot, budget.timeout_ms);
    const success = runResult.exit_code === 0;
    const combined = `${runResult.stdout}\n${runResult.stderr}`.trim();

    let normalized: ReturnType<typeof normalizeTerminalError> | null = null;
    if (!success) {
      normalized = normalizeTerminalError(combined, {
        command_kind: input.kind as CommandKind,
        workspace: data.identity.workspace_relative_path,
      });
    }

    const attemptId = store.insertTaskAttempt({
      task_run_id: input.task_run_id,
      project_id: data.identity.project_id,
      kind: "command",
      summary: `${input.kind} ${success ? "passed" : "failed"} (exit=${runResult.exit_code ?? "null"})`,
      success,
      metadata: {
        command_kind: input.kind,
        cmd: command.cmd,
        args: command.args,
        exit_code: runResult.exit_code,
        signal: runResult.signal,
        duration_ms: runResult.duration_ms,
        normalized_error: normalized?.normalized_error ?? null,
      },
    });

    return {
      ok: true,
      tool: "run_project_command",
      success,
      exit_code: runResult.exit_code,
      signal: runResult.signal,
      duration_ms: runResult.duration_ms,
      stdout_tail: clampTail(runResult.stdout),
      stderr_tail: clampTail(runResult.stderr),
      combined_tail: clampTail(combined),
      normalized_error: normalized?.normalized_error ?? null,
      detected_toolchain: normalized?.detected_toolchain ?? null,
      detected_language: normalized?.detected_language ?? null,
      error_class: normalized?.error_class ?? null,
      budget_remaining: remainingBudget(budget, store.getTaskRunCommandUsage(input.task_run_id)),
      attempt_id: attemptId,
      command: command,
    };
  } finally {
    store.close();
  }
}

async function createDebugSession(
  cwd: string,
  input: { task_text: string; initial_context?: string; approval_budget?: Partial<TaskBudget>; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const budget = defaultTaskBudget(input.approval_budget);
    const created = store.startTaskRun(data.identity.project_id, input.task_text, budget, randomUUID());
    if (input.initial_context) {
      store.insertTaskAttempt({
        task_run_id: created.id,
        project_id: data.identity.project_id,
        kind: "reasoning",
        summary: "initial debug context",
        success: true,
        metadata: { initial_context: input.initial_context },
      });
    }
    return {
      ok: true,
      tool: "create_debug_session",
      task_run_id: created.id,
      project_id: created.project_id,
      workspace_relative_path: data.identity.workspace_relative_path,
      recommended_flow: workflowSteps(),
      available_commands: ["test", "lint", "build", "typecheck"],
      budget: created.approval_budget,
    };
  } finally {
    store.close();
  }
}

async function recordErrorObservation(
  cwd: string,
  input: { task_run_id: string; raw_output: string; command_kind?: "test" | "lint" | "build" | "typecheck" | "manual"; context?: Record<string, unknown>; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const verified = verifyTaskRunForProject(store, input.task_run_id, data.identity.project_id);
    if (!verified.ok) return verified.body;
    const commandKind = input.command_kind === "manual" || !input.command_kind ? "unknown" : input.command_kind;
    const normalized = normalizeTerminalError(input.raw_output, {
      command_kind: commandKind as CommandKind,
      workspace: data.identity.workspace_relative_path,
    });
    const tracked = upsertNormalizedErrorSignature({
      store,
      identity: data.identity,
      profile: data.profile,
      normalized,
      commandKind: input.command_kind ?? "manual",
      taskRunId: input.task_run_id,
      rawLog: input.raw_output,
    });
    const attemptKind = input.command_kind && input.command_kind !== "manual" ? "command" : "reasoning";
    store.insertTaskAttempt({
      task_run_id: input.task_run_id,
      project_id: data.identity.project_id,
      kind: attemptKind,
      summary: `observed ${normalized.error_class}`,
      success: false,
      metadata: {
        command_kind: input.command_kind ?? "manual",
        normalized,
        context: input.context ?? {},
      },
    });
    return {
      ok: true,
      tool: "record_error_observation",
      normalized_error: normalized,
      error_signature: mapSignatureForOutput(tracked.signature),
      occurrence_id: tracked.occurrenceId,
      suggested_search_query: suggestedSearchQuery(normalized),
      suggested_filters: {
        language: normalized.detected_language !== "unknown" ? normalized.detected_language : undefined,
        toolchain: normalized.detected_toolchain !== "unknown" ? normalized.detected_toolchain : undefined,
        error_class: normalized.error_class !== "unknown_error" ? normalized.error_class : undefined,
        workspace: data.identity.workspace_relative_path,
      },
      should_search_memory: normalized.confidence > 0.35,
      confidence: normalized.confidence,
    };
  } finally {
    store.close();
  }
}

async function suggestNextActions(
  cwd: string,
  input: { task_run_id: string; normalized_error?: Record<string, unknown>; query?: string; limit: number; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const verified = verifyTaskRunForProject(store, input.task_run_id, data.identity.project_id);
    if (!verified.ok) return verified.body;
    const attempts = store.getTaskAttempts(input.task_run_id);
    const latestNormalized = attempts
      .map((a) => a.metadata.normalized)
      .find((n): n is Record<string, unknown> => !!n && typeof n === "object");
    const normalized = input.normalized_error ?? latestNormalized ?? {};
    const derivedQuery = [normalized.error_class, normalized.detected_toolchain, normalized.detected_language, normalized.normalized_error]
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);
    const query = input.query ?? (derivedQuery || verified.taskRun.task_text);
    const results = store.searchProjectExperience(data.identity.project_id, query, {}, input.limit);
    const correctionRows = store.listUserCorrections(data.identity.project_id, {}, 100);
    const warningRows = buildCorrectionWarnings(correctionRows, {
      query,
      language: String(normalized.detected_language ?? normalized.language ?? ""),
      toolchain: String(normalized.detected_toolchain ?? normalized.toolchain ?? ""),
      error_class: String(normalized.error_class ?? ""),
    });
    const cautionFromCorrections = warningRows.map((w) => {
      const avoid = w.rejected_pattern ? `Avoid ${String(w.rejected_pattern)}.` : "Avoid previously rejected fix pattern.";
      const prefer = w.preferred_pattern ? ` Prefer ${String(w.preferred_pattern)}.` : "";
      const rule = w.future_rule ? ` ${String(w.future_rule)}` : "";
      return `${avoid}${prefer}${rule}`.trim();
    });
    return {
      ok: true,
      tool: "suggest_next_actions",
      query,
      relevant_memories: results,
      suggested_actions: deterministicActions(normalized),
      cautions: [
        "Do not patch unless the target block is exact and unique.",
        "Do not commit memory until the fix has been verified.",
        "Stay within the task command budget.",
        ...cautionFromCorrections,
      ],
      recommended_command_to_run_next: commandRecommendation(normalized),
    };
  } finally {
    store.close();
  }
}

async function finalizeSuccessfulFix(
  cwd: string,
  input: {
    task_run_id: string;
    summary: string;
    root_cause: string;
    fix_pattern: string;
    symptoms?: string[];
    anti_patterns?: string[];
    verification_steps?: string[];
    files_changed?: string[];
    error_class?: string;
    language?: string;
    toolchain?: string;
    workspace?: string;
    confidence: number;
    error_signature_id?: string;
    error_signature_hash?: string;
    workspace_path?: string;
  },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const verified = verifyTaskRunForProject(store, input.task_run_id, data.identity.project_id);
    if (!verified.ok) return verified.body;
    let linkedSignature: ErrorSignatureRow | null = null;
    if (input.error_signature_id) {
      const byId = store.getErrorSignatureById(input.error_signature_id);
      if (!byId) return { ok: false, reason: "error_signature_not_found", error_signature_id: input.error_signature_id };
      if (byId.project_id !== data.identity.project_id) {
        return { ok: false, reason: "error_signature_project_mismatch", error_signature_id: input.error_signature_id };
      }
      linkedSignature = byId;
    } else if (input.error_signature_hash) {
      const byHash = store.getErrorSignatureByHash(data.identity.project_id, input.error_signature_hash);
      if (!byHash) return { ok: false, reason: "error_signature_not_found", error_signature_hash: input.error_signature_hash };
      linkedSignature = byHash;
    } else {
      linkedSignature = store.getLatestErrorSignatureForTaskRun(data.identity.project_id, input.task_run_id);
    }

    const metadata = {
      root_cause: input.root_cause,
      fix_pattern: input.fix_pattern,
      symptoms: input.symptoms ?? [],
      anti_patterns: input.anti_patterns ?? [],
      verification_steps: input.verification_steps ?? [],
      files: input.files_changed ?? [],
      error_class: input.error_class,
      language: input.language,
      toolchain: input.toolchain,
      workspace: input.workspace ?? data.identity.workspace_relative_path,
      task_run_id: input.task_run_id,
      linked_error_signature_id: linkedSignature?.id ?? null,
      linked_error_signature_hash: linkedSignature?.signature_hash ?? null,
    };
    const memorySummary = buildMemorySummaryForType("incident", input.summary, metadata);
    const inserted = store.insertMemoryRecord(data.identity.project_id, {
      type: "incident",
      scope: "workspace-only",
      content: input.summary,
      confidence: input.confidence,
      summary: memorySummary,
      metadata,
    });
    store.updateTaskRunStatus(input.task_run_id, "succeeded", input.summary);
    store.insertTaskAttempt({
      task_run_id: input.task_run_id,
      project_id: data.identity.project_id,
      kind: "memory",
      summary: "finalized successful fix",
      success: true,
      metadata: { memory_record_id: inserted.id, status: inserted.status },
    });
    if (linkedSignature) {
      store.linkErrorSignatureToMemory(linkedSignature.id, inserted.id);
    }
    return {
      ok: true,
      tool: "finalize_successful_fix",
      memory_record_id: inserted.id,
      task_run_id: input.task_run_id,
      status: "succeeded",
      vectorization_status: inserted.status,
      linked_error_signature_id: linkedSignature?.id ?? null,
      linked_error_signature_hash: linkedSignature?.signature_hash ?? null,
    };
  } finally {
    store.close();
  }
}

export async function getRecurringErrors(
  cwd: string,
  input: {
    workspace_path?: string;
    limit: number;
    min_occurrences: number;
    language?: string;
    toolchain?: string;
    error_class?: string;
  },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const rows = store.listRecurringErrors(data.identity.project_id, input);
    return {
      ok: true,
      tool: "get_recurring_errors",
      project_id: data.identity.project_id,
      workspace_relative_path: data.identity.workspace_relative_path,
      recurring_errors: rows.map((row) => ({
        id: row.id,
        signature_hash: row.signature_hash,
        error_class: row.error_class,
        language: row.language,
        toolchain: row.toolchain,
        normalized_message: row.normalized_message,
        file_hint: row.file_hint,
        occurrence_count: row.occurrence_count,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        linked_memory_id: row.linked_memory_id,
        has_verified_fix: Boolean(row.linked_memory_id),
      })),
    };
  } finally {
    store.close();
  }
}

async function failDebugSession(
  cwd: string,
  input: { task_run_id: string; reason: string; summary?: string; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  try {
    const verified = verifyTaskRunForProject(store, input.task_run_id, data.identity.project_id);
    if (!verified.ok) return verified.body;
    store.updateTaskRunStatus(input.task_run_id, "failed", input.summary ?? input.reason);
    store.insertTaskAttempt({
      task_run_id: input.task_run_id,
      project_id: data.identity.project_id,
      kind: "reasoning",
      summary: input.summary ?? input.reason,
      success: false,
      metadata: { reason: input.reason },
    });
    return {
      ok: true,
      tool: "fail_debug_session",
      task_run_id: input.task_run_id,
      status: "failed",
    };
  } finally {
    store.close();
  }
}

export async function vectorizePendingMemories(
  cwd: string,
  input: { limit: number; retry_failed: boolean; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  const config = getEmbeddingConfig();
  const model = config.model;
  const embeddingClient = getEmbeddingClient();
  if (!config.embeddings_enabled) {
    embeddingClient.setDisabledState();
    store.close();
    return {
      ok: true,
      tool: "vectorize_pending_memories",
      model,
      embeddings_enabled: false,
      worker_state: embeddingClient.getState(),
      vector_search_enabled: false,
      processed_count: 0,
      ready_count: 0,
      failed_count: 0,
      skipped_count: 0,
      records: [],
      message: "Embeddings disabled by BUGRECALL_EMBEDDINGS=off",
    };
  }

  const effectiveLimit = Math.min(input.limit, config.max_batch);
  let readyCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const records: Array<Record<string, unknown>> = [];
  const t0 = Date.now();

  try {
    if (input.retry_failed) {
      store.resetFailedVectorizationRecords(data.identity.project_id, effectiveLimit);
    }
    const queue = store.listPendingVectorizationRecordsForProject(
      data.identity.project_id,
      effectiveLimit,
      input.retry_failed,
    );

    for (const record of queue) {
      try {
        console.error(`[embedder] vectorizing record ${record.id}`);
        const cached = store.getEmbeddingCacheEntry(record.id);
        if (cached && cached.model === model && cached.content_hash === record.content_hash) {
          store.markVectorizationReady(record.id);
          skippedCount += 1;
          records.push({ id: record.id, status: "ready", skipped: true, reason: "cache-hit", dimension: cached.dimension });
          console.error(`[embedder] record ready via cache ${record.id}`);
          continue;
        }

        const recStart = Date.now();
        const result = await embeddingClient.embed(record.id, record.embedding_text, model, config.timeout_ms);
        const vector = new Float32Array(result.vector);
        if (result.dimension !== 384) {
          throw new Error(`Unexpected dimension ${result.dimension}; expected 384`);
        }
        store.upsertEmbeddingCache({
          record_id: record.id,
          project_id: data.identity.project_id,
          model,
          dimension: result.dimension,
          vector,
          content_hash: record.content_hash,
        });
        store.markVectorizationReady(record.id);
        readyCount += 1;
        records.push({
          id: record.id,
          status: "ready",
          dimension: result.dimension,
          duration_ms: Date.now() - recStart,
        });
        console.error(`[embedder] record ready ${record.id}`);
      } catch (error: unknown) {
        let message = error instanceof Error ? error.message : String(error);
        if (message.includes("Protobuf parsing failed")) {
          try {
            const cachePath = path.join(
              data.repoRoot,
              "node_modules",
              "@huggingface",
              "transformers",
              ".cache",
              model,
            );
            await rm(cachePath, { recursive: true, force: true });
            console.error(`[embedder] cache cleared after protobuf failure: ${cachePath}`);
            const retry = await embeddingClient.embed(record.id, record.embedding_text, model, config.timeout_ms);
            const retryVec = new Float32Array(retry.vector);
            if (retry.dimension !== 384) throw new Error(`Unexpected dimension ${retry.dimension}; expected 384`);
            store.upsertEmbeddingCache({
              record_id: record.id,
              project_id: data.identity.project_id,
              model,
              dimension: retry.dimension,
              vector: retryVec,
              content_hash: record.content_hash,
            });
            store.markVectorizationReady(record.id);
            readyCount += 1;
            records.push({ id: record.id, status: "ready", dimension: retry.dimension, retried: true });
            console.error(`[embedder] record ready after retry ${record.id}`);
            continue;
          } catch (retryError: unknown) {
            message = retryError instanceof Error ? retryError.message : String(retryError);
          }
        }
        store.markVectorizationFailed(record.id, message);
        failedCount += 1;
        records.push({ id: record.id, status: "failed", error: message });
        console.error(`[embedder] record failed ${record.id}: ${message}`);
      }
    }

    return {
      ok: true,
      tool: "vectorize_pending_memories",
      model,
      embeddings_enabled: true,
      worker_state: embeddingClient.getState(),
      last_worker_error: embeddingClient.getLastError(),
      vector_search_enabled: false,
      processed_count: queue.length,
      ready_count: readyCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      total_duration_ms: Date.now() - t0,
      records,
    };
  } finally {
    store.close();
  }
}

export async function getVectorizationStatus(
  cwd: string,
  input: { limit?: number; workspace_path?: string },
): Promise<Record<string, unknown>> {
  const data = await buildIdentityAndProfile(cwd, input.workspace_path);
  const { store } = await ensureStore(data.agentRoot);
  const config = getEmbeddingConfig();
  const embeddingClient = getEmbeddingClient();
  if (!config.embeddings_enabled) embeddingClient.setDisabledState();
  try {
    const status = store.getVectorizationStatus(data.identity.project_id);
    const vectorStoreStatus = await getVectorStoreStatus();
    return {
      ok: true,
      tool: "get_vectorization_status",
      model: config.model,
      embeddings_enabled: config.embeddings_enabled,
      worker_state: embeddingClient.getState(),
      last_worker_error: embeddingClient.getLastError(),
      vector_search_enabled: vectorStoreStatus.state === "available",
      vector_store_status: vectorStoreStatus,
      indexed_count: store.countIndexedReadyRecords(data.identity.project_id),
      ...status,
    };
  } finally {
    store.close();
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "health_check",
      description: "Returns basic service health status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "bootstrap_project",
      description: "Bootstrap local project and persist project/profile rows in SQLite.",
      inputSchema: { type: "object", properties: { workspace_path: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "get_project_profile",
      description: "Return detected project identity and profile metadata.",
      inputSchema: { type: "object", properties: { workspace_path: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "read_project_memory",
      description: "Read latest high-confidence memory records for current project.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...memoryTypeValues] },
          limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
          workspace_path: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "commit_postmortem",
      description: "Store incident/fact/decision memory record for current project.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["incident", "fact", "decision"], default: "incident" },
          scope: { type: "string", enum: ["workspace-only", "project-only", "repo-family"], default: "workspace-only" },
          content: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
          metadata: { type: "object", additionalProperties: true },
          workspace_path: { type: "string" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    {
      name: "ingest_terminal_error",
      description: "Normalize terminal error logs into structured incident candidate without saving memory.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_path: { type: "string" },
          raw_log: { type: "string" },
          command_kind: { type: "string", enum: ["test", "lint", "build", "typecheck", "run", "unknown"] },
          workspace: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["raw_log"],
        additionalProperties: false,
      },
    },
    {
      name: "search_project_experience",
      description: "Search project memory records via text, vector, or hybrid retrieval with safe fallback.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_path: { type: "string" },
          query: { type: "string" },
          mode: { type: "string", enum: ["auto", "text", "vector", "hybrid"], default: "auto" },
          detail_level: { type: "string", enum: ["summary", "full"], default: "summary" },
          include_warnings: { type: "boolean", default: true },
          error_signature_id: { type: "string" },
          error_signature_hash: { type: "string" },
          filters: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...memoryTypeValues] },
              workspace: { type: "string" },
              toolchain: { type: "string" },
              language: { type: "string" },
              framework: { type: "string" },
              error_class: { type: "string" },
              min_confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            additionalProperties: false,
          },
          limit: { type: "number", minimum: 1, maximum: 50, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_memory_detail",
      description: "Fetch full memory content and linked signature details by memory id.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_path: { type: "string" },
          memory_id: { type: "string" },
        },
        required: ["memory_id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_recurring_errors",
      description: "List recurring normalized error signatures for current workspace project.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_path: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 200, default: 20 },
          min_occurrences: { type: "number", minimum: 1, maximum: 1000, default: 2 },
          language: { type: "string" },
          toolchain: { type: "string" },
          error_class: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "record_user_correction",
      description: "Store user rejection/preference guidance as workspace-scoped memory.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_path: { type: "string" },
          correction_type: { type: "string", enum: ["rejected_fix", "project_preference"], default: "project_preference" },
          context: { type: "string" },
          user_feedback: { type: "string" },
          rejected_pattern: { type: "string" },
          preferred_pattern: { type: "string" },
          future_rule: { type: "string" },
          applies_to: { type: "object", additionalProperties: true },
          confidence: { type: "number", minimum: 0, maximum: 1, default: 0.9 },
        },
        required: ["context", "user_feedback", "future_rule"],
        additionalProperties: false,
      },
    },
    {
      name: "list_user_corrections",
      description: "List workspace-scoped user corrections and project preferences.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_path: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 500, default: 50 },
          correction_type: { type: "string", enum: ["rejected_fix", "project_preference"] },
          language: { type: "string" },
          framework: { type: "string" },
          toolchain: { type: "string" },
          error_class: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "index_ready_memories",
      description: "Index ready memory embeddings into optional LanceDB vector store.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 500, default: 50 },
          rebuild: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: "apply_search_replace_patch",
      description: "Apply exact and unique search/replace patch with snapshot and patch history.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          search_block: { type: "string" },
          replace_block: { type: "string" },
          task_run_id: { type: "string" },
        },
        required: ["file_path", "search_block", "replace_block"],
        additionalProperties: false,
      },
    },
    {
      name: "restore_snapshot",
      description: "Restore file content from a stored snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          snapshot_id: { type: "string" },
        },
        required: ["snapshot_id"],
        additionalProperties: false,
      },
    },
    {
      name: "start_task_run",
      description: "Start a structured task run with command execution budget.",
      inputSchema: {
        type: "object",
        properties: {
          task_text: { type: "string" },
          approval_budget: {
            type: "object",
            properties: {
              max_total_command_runs: { type: "number", minimum: 1, maximum: 100, default: 5 },
              max_test_runs: { type: "number", minimum: 1, maximum: 100, default: 5 },
              max_lint_runs: { type: "number", minimum: 1, maximum: 100, default: 3 },
              max_build_runs: { type: "number", minimum: 1, maximum: 100, default: 3 },
              max_typecheck_runs: { type: "number", minimum: 1, maximum: 100, default: 3 },
              timeout_ms: { type: "number", minimum: 1000, maximum: 300000, default: 30000 },
            },
            additionalProperties: false,
          },
        },
        required: ["task_text"],
        additionalProperties: false,
      },
    },
    {
      name: "get_task_run",
      description: "Read task run state and command usage.",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
        },
        required: ["task_run_id"],
        additionalProperties: false,
      },
    },
    {
      name: "run_project_command",
      description: "Run configured project command (test/lint/build/typecheck) with budget checks.",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
          kind: { type: "string", enum: ["test", "lint", "build", "typecheck"] },
          workspace_path: { type: "string" },
        },
        required: ["task_run_id", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "log_attempt",
      description: "Log a task attempt (patch/command/reasoning/memory).",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
          kind: { type: "string", enum: ["patch", "command", "reasoning", "memory"] },
          summary: { type: "string" },
          success: { type: "boolean" },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["task_run_id", "kind", "summary", "success"],
        additionalProperties: false,
      },
    },
    {
      name: "create_debug_session",
      description: "Create a controlled debug workflow session.",
      inputSchema: {
        type: "object",
        properties: {
          task_text: { type: "string" },
          initial_context: { type: "string" },
          workspace_path: { type: "string" },
          approval_budget: {
            type: "object",
            properties: {
              max_total_command_runs: { type: "number", minimum: 1, maximum: 100, default: 5 },
              max_test_runs: { type: "number", minimum: 1, maximum: 100, default: 5 },
              max_lint_runs: { type: "number", minimum: 1, maximum: 100, default: 3 },
              max_build_runs: { type: "number", minimum: 1, maximum: 100, default: 3 },
              max_typecheck_runs: { type: "number", minimum: 1, maximum: 100, default: 3 },
              timeout_ms: { type: "number", minimum: 1000, maximum: 300000, default: 30000 },
            },
            additionalProperties: false,
          },
        },
        required: ["task_text"],
        additionalProperties: false,
      },
    },
    {
      name: "record_error_observation",
      description: "Normalize and log an observed terminal/debug error without writing memory.",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
          raw_output: { type: "string" },
          command_kind: { type: "string", enum: ["test", "lint", "build", "typecheck", "manual"] },
          context: { type: "object", additionalProperties: true },
          workspace_path: { type: "string" },
        },
        required: ["task_run_id", "raw_output"],
        additionalProperties: false,
      },
    },
    {
      name: "suggest_next_actions",
      description: "Suggest deterministic next debug actions using current error and project memory.",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
          normalized_error: { type: "object", additionalProperties: true },
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20, default: 5 },
          workspace_path: { type: "string" },
        },
        required: ["task_run_id"],
        additionalProperties: false,
      },
    },
    {
      name: "finalize_successful_fix",
      description: "Create a postmortem memory for a verified fix and mark debug session succeeded.",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
          summary: { type: "string" },
          root_cause: { type: "string" },
          fix_pattern: { type: "string" },
          symptoms: { type: "array", items: { type: "string" } },
          anti_patterns: { type: "array", items: { type: "string" } },
          verification_steps: { type: "array", items: { type: "string" } },
          files_changed: { type: "array", items: { type: "string" } },
          error_class: { type: "string" },
          language: { type: "string" },
          toolchain: { type: "string" },
          workspace: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1, default: 0.9 },
          workspace_path: { type: "string" },
        },
        required: ["task_run_id", "summary", "root_cause", "fix_pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "fail_debug_session",
      description: "Mark a debug workflow session failed without writing memory.",
      inputSchema: {
        type: "object",
        properties: {
          task_run_id: { type: "string" },
          reason: { type: "string" },
          summary: { type: "string" },
        },
        required: ["task_run_id", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "vectorize_pending_memories",
      description: "Process pending vectorization records and cache embeddings in SQLite.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
          retry_failed: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_vectorization_status",
      description: "Return vectorization queue and embedding cache status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
  ];
  return { tools: tools.filter((tool) => isToolVisible(tool.name)) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (activeToolset === "codex" && fullToolNameSet.has(request.params.name) && !codexToolNameSet.has(request.params.name)) {
      const body = {
        ok: false,
        reason: "tool_not_available_in_toolset",
        toolset: activeToolset,
        tool_name: request.params.name,
      };
      return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
    }

    if (request.params.name === "health_check") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              service: "project-memory-agent",
              version: "0.2.0",
              active_toolset: activeToolset,
              tool_count: getVisibleToolCount(),
            }),
          },
        ],
      };
    }

    if (request.params.name === "bootstrap_project") {
      const parsed = bootstrapProjectInputSchema.parse(request.params.arguments ?? {});
      const result = await bootstrapProject(process.cwd(), parsed.workspace_path);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    if (request.params.name === "get_project_profile") {
      const parsed = getProjectProfileInputSchema.parse(request.params.arguments ?? {});
      const result = await getProjectProfile(process.cwd(), parsed.workspace_path);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

  if (request.params.name === "read_project_memory") {
    const parsed = readProjectMemoryInputSchema.parse(request.params.arguments ?? {});
    const result = await readProjectMemory(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "commit_postmortem") {
    const parsed = commitPostmortemInputSchema.parse(request.params.arguments ?? {});
    const result = await commitPostmortem(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "ingest_terminal_error") {
    const parsed = ingestTerminalErrorInputSchema.parse(request.params.arguments ?? {});
    const result = await ingestTerminalError(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "search_project_experience") {
    const parsed = searchProjectExperienceInputSchema.parse(request.params.arguments ?? {});
    const result = await searchProjectExperience(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "get_memory_detail") {
    const parsed = getMemoryDetailInputSchema.parse(request.params.arguments ?? {});
    const result = await getMemoryDetail(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.ok === false };
  }

  if (request.params.name === "get_recurring_errors") {
    const parsed = getRecurringErrorsInputSchema.parse(request.params.arguments ?? {});
    const result = await getRecurringErrors(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "record_user_correction") {
    const parsed = recordUserCorrectionInputSchema.parse(request.params.arguments ?? {});
    const result = await recordUserCorrection(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.ok === false };
  }

  if (request.params.name === "list_user_corrections") {
    const parsed = listUserCorrectionsInputSchema.parse(request.params.arguments ?? {});
    const result = await listUserCorrections(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "index_ready_memories") {
    const parsed = indexReadyMemoriesInputSchema.parse(request.params.arguments ?? {});
    const result = await indexReadyMemories(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "apply_search_replace_patch") {
    const parsed = applySearchReplacePatchInputSchema.parse(request.params.arguments ?? {});
    const result = await applySearchReplacePatch(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "restore_snapshot") {
    const parsed = restoreSnapshotInputSchema.parse(request.params.arguments ?? {});
    const result = await restoreSnapshot(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "start_task_run") {
    const parsed = startTaskRunInputSchema.parse(request.params.arguments ?? {});
    const result = await startTaskRun(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "get_task_run") {
    const parsed = getTaskRunInputSchema.parse(request.params.arguments ?? {});
    const result = await getTaskRun(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "run_project_command") {
    const parsed = runProjectCommandInputSchema.parse(request.params.arguments ?? {});
    const result = await runProjectCommand(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "log_attempt") {
    const parsed = logAttemptInputSchema.parse(request.params.arguments ?? {});
    const result = await logAttempt(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "create_debug_session") {
    const parsed = createDebugSessionInputSchema.parse(request.params.arguments ?? {});
    const result = await createDebugSession(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "record_error_observation") {
    const parsed = recordErrorObservationInputSchema.parse(request.params.arguments ?? {});
    const result = await recordErrorObservation(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "suggest_next_actions") {
    const parsed = suggestNextActionsInputSchema.parse(request.params.arguments ?? {});
    const result = await suggestNextActions(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "finalize_successful_fix") {
    const parsed = finalizeSuccessfulFixInputSchema.parse(request.params.arguments ?? {});
    const result = await finalizeSuccessfulFix(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "fail_debug_session") {
    const parsed = failDebugSessionInputSchema.parse(request.params.arguments ?? {});
    const result = await failDebugSession(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "vectorize_pending_memories") {
    const parsed = vectorizePendingMemoriesInputSchema.parse(request.params.arguments ?? {});
    const result = await vectorizePendingMemories(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "get_vectorization_status") {
    const parsed = getVectorizationStatusInputSchema.parse(request.params.arguments ?? {});
    const result = await getVectorizationStatus(process.cwd(), parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error: unknown) {
    if (error instanceof WorkspacePathResolutionError) {
      const body = {
        ok: false,
        reason: error.reason,
        workspace_path: error.workspace_path,
      };
      return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
    }
    if (error instanceof z.ZodError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "invalid_arguments", issues: error.issues }) }],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "internal_error", message }) }], isError: true };
  }
});

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pma] MCP server connected via stdio");
}
