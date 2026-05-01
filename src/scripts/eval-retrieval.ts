import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRetrievalEval } from "../engine/evaluation/retrievalEval.js";
import type { EvalMode } from "../engine/evaluation/types.js";

type CliOptions = {
  fixturePath: string;
  keepTemp: boolean;
  json: boolean;
  modeOverride?: EvalMode;
  workspacePathOverride?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");
  const opts: CliOptions = {
    fixturePath: path.join(repoRoot, "eval", "retrieval", "basic-debug-memory.json"),
    keepTemp: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-temp") opts.keepTemp = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--fixture") opts.fixturePath = path.resolve(repoRoot, argv[i + 1] ?? "");
    else if (arg === "--mode") opts.modeOverride = (argv[i + 1] as EvalMode | undefined) ?? undefined;
    else if (arg === "--workspace_path") opts.workspacePathOverride = argv[i + 1];
  }
  return opts;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runRetrievalEval(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }

  const lines: string[] = [];
  lines.push(`Retrieval Eval: ${report.name}`);
  lines.push("");
  lines.push("Cases:");
  for (const c of report.cases) {
    lines.push(`${c.passed ? "✓" : "✗"} ${c.name}`);
  }
  lines.push("");
  lines.push("Metrics:");
  lines.push(`top1_accuracy: ${report.metrics.top1_accuracy.toFixed(2)}`);
  lines.push(`top3_recall: ${report.metrics.top3_recall.toFixed(2)}`);
  lines.push(`mrr: ${report.metrics.mrr.toFixed(2)}`);
  lines.push(`warning_recall: ${report.metrics.warning_recall.toFixed(2)}`);
  lines.push(`false_positive_count: ${report.metrics.false_positive_count}`);
  lines.push("");
  lines.push(report.passed ? "PASS" : "FAIL");
  console.log(lines.join("\n"));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
