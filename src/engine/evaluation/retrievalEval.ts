import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type {
  EvalCase,
  EvalMode,
  RetrievalEvalCaseReport,
  RetrievalEvalFixture,
  RetrievalEvalMetrics,
  RetrievalEvalReport,
  RunRetrievalEvalOptions,
} from "./types.js";

const fixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  workspace_path: z.string().min(1),
  mode: z.enum(["auto", "text", "vector", "hybrid"]).optional().default("text"),
  detail_level: z.enum(["summary", "full"]).optional().default("summary"),
  include_warnings: z.boolean().optional().default(true),
  thresholds: z
    .object({
      top1_accuracy: z.number().min(0).max(1).optional().default(0.75),
      top3_recall: z.number().min(0).max(1).optional().default(1),
      mrr: z.number().min(0).max(1).optional().default(0.8),
      warning_recall: z.number().min(0).max(1).optional().default(1),
      false_positive_count: z.number().int().min(0).optional().default(0),
    })
    .optional()
    .default({}),
  seed: z.object({
    verified_memories: z.array(
      z.object({
        label: z.string().min(1),
        type: z.enum(["incident", "fact", "decision"]),
        error_class: z.string().optional(),
        language: z.string().optional(),
        framework: z.string().optional(),
        toolchain: z.string().optional(),
        summary: z.string().min(1),
        content: z.string().optional(),
        root_cause: z.string().optional(),
        fix_pattern: z.string().optional(),
        anti_patterns: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional().default(0.9),
      }),
    ),
    user_corrections: z.array(
      z.object({
        label: z.string().min(1),
        correction_type: z.enum(["rejected_fix", "project_preference"]),
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
      }),
    ),
  }),
  cases: z.array(
    z.object({
      name: z.string().min(1),
      query: z.string().min(1),
      filters: z
        .object({
          type: z.string().optional(),
          workspace: z.string().optional(),
          toolchain: z.string().optional(),
          language: z.string().optional(),
          framework: z.string().optional(),
          error_class: z.string().optional(),
          min_confidence: z.number().min(0).max(1).optional(),
        })
        .optional(),
      expected_top_label: z.string().optional(),
      expected_top3_labels: z.array(z.string()).optional(),
      expected_warning_labels: z.array(z.string()).optional(),
      must_not_top1_labels: z.array(z.string()).optional(),
      must_not_top3_labels: z.array(z.string()).optional(),
    }),
  ),
});

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClientInCwd<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../../..");
  const pmaPath = path.join(repoRoot, "bin", "pma.js");
  const client = new Client({ name: "retrieval-eval", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: [pmaPath], cwd });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function createFixtureRepo(baseDir: string): Promise<string> {
  const repoDir = path.join(baseDir, "repo");
  await mkdir(path.join(repoDir, "apps", "web"), { recursive: true });
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ private: true, name: "eval-root", scripts: { test: "node root-test.js" } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(repoDir, "root-test.js"), "console.log('ROOT_TEST_RAN')\n", "utf8");
  await writeFile(
    path.join(repoDir, "apps", "web", "package.json"),
    JSON.stringify({ private: true, name: "eval-web", scripts: { test: "node web-test.js" } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(repoDir, "apps", "web", "web-test.js"), "console.log('WEB_TEST_RAN')\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "eval@example.com"], repoDir);
  runGit(["config", "user.name", "eval"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function findRank(labels: string[], expected: string): number | null {
  const idx = labels.indexOf(expected);
  return idx >= 0 ? idx + 1 : null;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export async function runRetrievalEval(options: RunRetrievalEvalOptions): Promise<RetrievalEvalReport> {
  const fixtureRaw = JSON.parse(await readFile(options.fixturePath, "utf8")) as unknown;
  const fixture = fixtureSchema.parse(fixtureRaw) as RetrievalEvalFixture;
  const mode = (options.modeOverride ?? fixture.mode ?? "text") as EvalMode;
  const workspacePath = options.workspacePathOverride ?? fixture.workspace_path;

  const baseDir = await mkdtemp(path.join(tmpdir(), "bugrecall-eval-"));
  let report: RetrievalEvalReport | null = null;
  try {
    const repoDir = await createFixtureRepo(baseDir);
    report = await withClientInCwd(repoDir, async (client) => {
      parseToolText(await client.callTool({ name: "bootstrap_project", arguments: {} }));
      parseToolText(await client.callTool({ name: "bootstrap_project", arguments: { workspace_path: workspacePath } }));

      const labelToMemoryId = new Map<string, string>();
      const labelToWarningId = new Map<string, string>();
      const memoryIdToLabel = new Map<string, string>();

      for (const row of fixture.seed.verified_memories) {
        const committed = parseToolText(
          await client.callTool({
            name: "commit_postmortem",
            arguments: {
              workspace_path: workspacePath,
              type: row.type,
              scope: "workspace-only",
              content: row.content ?? row.summary,
              confidence: row.confidence ?? 0.9,
              metadata: {
                summary: row.summary,
                root_cause: row.root_cause,
                fix_pattern: row.fix_pattern,
                anti_patterns: row.anti_patterns ?? [],
                error_class: row.error_class,
                language: row.language,
                framework: row.framework,
                toolchain: row.toolchain,
                eval_label: row.label,
              },
            },
          }),
        );
        const id = String(committed.record_id ?? "");
        if (id) {
          labelToMemoryId.set(row.label, id);
          memoryIdToLabel.set(id, row.label);
        }
      }

      for (const row of fixture.seed.user_corrections) {
        const correction = parseToolText(
          await client.callTool({
            name: "record_user_correction",
            arguments: {
              workspace_path: workspacePath,
              correction_type: row.correction_type,
              context: row.context,
              user_feedback: row.user_feedback,
              rejected_pattern: row.rejected_pattern,
              preferred_pattern: row.preferred_pattern,
              future_rule: row.future_rule,
              applies_to: row.applies_to ?? {},
              confidence: row.confidence ?? 0.9,
            },
          }),
        );
        const id = String(correction.memory_id ?? "");
        if (id) {
          labelToWarningId.set(row.label, id);
          memoryIdToLabel.set(id, row.label);
        }
      }

      const caseReports: RetrievalEvalCaseReport[] = [];
      let top1Total = 0;
      let top1Correct = 0;
      let top3Total = 0;
      let top3Hit = 0;
      let mrrTotal = 0;
      let mrrSum = 0;
      let warningExpectedTotal = 0;
      let warningHitTotal = 0;
      let falsePositiveCount = 0;

      for (const testCase of fixture.cases as EvalCase[]) {
        const search = parseToolText(
          await client.callTool({
            name: "search_project_experience",
            arguments: {
              workspace_path: workspacePath,
              query: testCase.query,
              filters: testCase.filters ?? {},
              mode,
              detail_level: fixture.detail_level ?? "summary",
              include_warnings: fixture.include_warnings ?? true,
              limit: 10,
            },
          }),
        );

        const results = Array.isArray(search.results) ? (search.results as Array<Record<string, unknown>>) : [];
        const warnings = Array.isArray(search.warnings) ? (search.warnings as Array<Record<string, unknown>>) : [];

        const topLabels = results.slice(0, 3).map((r) => memoryIdToLabel.get(String(r.id ?? "")) ?? "");
        const warningLabels = warnings.map((w) => memoryIdToLabel.get(String(w.memory_id ?? "")) ?? "");

        const failures: string[] = [];
        if (testCase.expected_top_label) {
          top1Total += 1;
          if (topLabels[0] === testCase.expected_top_label) top1Correct += 1;
          else failures.push("expected_top_label_mismatch");
        }
        if (testCase.expected_top3_labels && testCase.expected_top3_labels.length > 0) {
          top3Total += 1;
          const found = testCase.expected_top3_labels.some((label) => topLabels.includes(label));
          if (found) top3Hit += 1;
          else failures.push("expected_top3_missing");
        }
        if (testCase.expected_warning_labels && testCase.expected_warning_labels.length > 0) {
          for (const label of testCase.expected_warning_labels) {
            warningExpectedTotal += 1;
            if (warningLabels.includes(label)) warningHitTotal += 1;
            else failures.push("expected_warning_missing");
          }
        }

        if (testCase.must_not_top1_labels && testCase.must_not_top1_labels.length > 0) {
          if (testCase.must_not_top1_labels.includes(topLabels[0])) {
            falsePositiveCount += 1;
            failures.push("forbidden_top1_present");
          }
        }
        if (testCase.must_not_top3_labels && testCase.must_not_top3_labels.length > 0) {
          for (const forbidden of testCase.must_not_top3_labels) {
            if (topLabels.includes(forbidden)) {
              falsePositiveCount += 1;
              failures.push("forbidden_top3_present");
            }
          }
        }

        const targetForMrr = testCase.expected_top_label ?? testCase.expected_top3_labels?.[0];
        if (targetForMrr) {
          mrrTotal += 1;
          const fullLabels = results.map((r) => memoryIdToLabel.get(String(r.id ?? "")) ?? "");
          const rank = findRank(fullLabels, targetForMrr);
          if (rank) mrrSum += 1 / rank;
        }

        const first = results[0] ?? {};
        caseReports.push({
          name: testCase.name,
          passed: failures.length === 0,
          top_labels: topLabels.filter((v) => v),
          warning_labels: warningLabels.filter((v) => v),
          failures,
          rank_of_expected_top: testCase.expected_top_label
            ? findRank(results.map((r) => memoryIdToLabel.get(String(r.id ?? "")) ?? ""), testCase.expected_top_label)
            : null,
          sample_ranking_reasons: toStringArray(first.ranking_reasons),
          sample_ranking_breakdown:
            first.ranking_breakdown && typeof first.ranking_breakdown === "object"
              ? (first.ranking_breakdown as Record<string, unknown>)
              : null,
        });
      }

      const metrics: RetrievalEvalMetrics = {
        top1_accuracy: round(top1Total > 0 ? top1Correct / top1Total : 0),
        top3_recall: round(top3Total > 0 ? top3Hit / top3Total : 0),
        mrr: round(mrrTotal > 0 ? mrrSum / mrrTotal : 0),
        warning_recall: round(warningExpectedTotal > 0 ? warningHitTotal / warningExpectedTotal : 1),
        false_positive_count: falsePositiveCount,
      };

      const thresholds = {
        top1_accuracy: fixture.thresholds?.top1_accuracy ?? 0.75,
        top3_recall: fixture.thresholds?.top3_recall ?? 1,
        mrr: fixture.thresholds?.mrr ?? 0.8,
        warning_recall: fixture.thresholds?.warning_recall ?? 1,
        false_positive_count: fixture.thresholds?.false_positive_count ?? 0,
      };

      const passed =
        metrics.top1_accuracy >= thresholds.top1_accuracy &&
        metrics.top3_recall >= thresholds.top3_recall &&
        metrics.mrr >= thresholds.mrr &&
        metrics.warning_recall >= thresholds.warning_recall &&
        metrics.false_positive_count <= thresholds.false_positive_count &&
        caseReports.every((c) => c.passed);

      return {
        name: fixture.name,
        description: fixture.description,
        mode,
        detail_level: fixture.detail_level ?? "summary",
        include_warnings: fixture.include_warnings ?? true,
        workspace_path: workspacePath,
        passed,
        thresholds,
        metrics,
        cases: caseReports,
        seeded: {
          verified_count: fixture.seed.verified_memories.length,
          correction_count: fixture.seed.user_corrections.length,
        },
      } satisfies RetrievalEvalReport;
    });

    return report;
  } finally {
    if (!options.keepTemp) {
      await rm(baseDir, { recursive: true, force: true });
    }
  }
}
