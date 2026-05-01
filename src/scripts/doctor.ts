import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbeddingConfig } from "../engine/embedding/config.js";

function result(label: string, ok: boolean, detail: string): string {
  return `${ok ? "OK" : "FAIL"} ${label}: ${detail}`;
}

async function main(): Promise<void> {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");
  const pkgPath = path.join(repoRoot, "package.json");
  const binPath = path.join(repoRoot, "bin", "pma.js");
  const distCliPath = path.join(repoRoot, "dist", "cli.js");
  const distIndexPath = path.join(repoRoot, "dist", "index.js");
  const distDashboardPath = path.join(repoRoot, "dist", "dashboard", "server.js");

  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const embeddingConfig = getEmbeddingConfig();
  const host = process.env.BUGRECALL_DASHBOARD_HOST ?? "127.0.0.1";
  const port = process.env.BUGRECALL_DASHBOARD_PORT ?? "1453";

  const lines: string[] = [];
  lines.push(`Bugrecall Doctor`);
  lines.push(`Node: ${process.version}`);
  lines.push(`Package: ${String(pkg.name)}@${String(pkg.version)}`);
  lines.push(result("bin/pma.js", existsSync(binPath), binPath));
  lines.push(result("dist/cli.js", existsSync(distCliPath), distCliPath));
  lines.push(result("dist/index.js", existsSync(distIndexPath), distIndexPath));
  lines.push(result("dist/dashboard/server.js", existsSync(distDashboardPath), distDashboardPath));

  let coreImportsOk = true;
  try {
    await import(pathToFileUrl(distIndexPath));
    await import(pathToFileUrl(distDashboardPath));
  } catch (error) {
    coreImportsOk = false;
    lines.push(result("module imports", false, error instanceof Error ? error.message : String(error)));
  }
  if (coreImportsOk) lines.push(result("module imports", true, "core dist modules importable"));

  const require = createRequire(import.meta.url);
  let lancedbAvailable = false;
  try {
    require.resolve("@lancedb/lancedb");
    lancedbAvailable = true;
  } catch {
    lancedbAvailable = false;
  }
  lines.push(result("optional lancedb", true, lancedbAvailable ? "available" : "not installed/unavailable"));

  lines.push(result("embeddings enabled", true, String(embeddingConfig.embeddings_enabled)));
  lines.push(result("embedding model", true, embeddingConfig.model));
  lines.push(result("embedding timeout", true, `${embeddingConfig.timeout_ms}ms`));
  lines.push(result("embedding max batch", true, String(embeddingConfig.max_batch)));
  lines.push(result("dashboard default", true, `http://${host}:${port}`));

  console.log(lines.join("\n"));

  const criticalMissing = [binPath, distCliPath, distIndexPath].some((p) => !existsSync(p));
  if (criticalMissing || !coreImportsOk) process.exit(1);
}

function pathToFileUrl(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
