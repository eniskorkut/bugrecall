import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type PackageJson = {
  private?: boolean;
  engines?: { node?: string };
  license?: string;
  files?: string[];
  scripts?: Record<string, string>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");

  assert(existsSync(path.join(repoRoot, "src/scripts/package-check.ts")), "src/scripts/package-check.ts missing");
  assert(existsSync(path.join(repoRoot, "LICENSE")), "LICENSE missing");
  assert(existsSync(path.join(repoRoot, "CHANGELOG.md")), "CHANGELOG.md missing");
  assert(existsSync(path.join(repoRoot, "SECURITY.md")), "SECURITY.md missing");
  assert(existsSync(path.join(repoRoot, "docs/release.md")), "docs/release.md missing");
  assert(existsSync(path.join(repoRoot, ".github/workflows/ci.yml")), ".github/workflows/ci.yml missing");

  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
  assert(pkg.private === true, "package.json private must remain true");
  assert(typeof pkg.engines?.node === "string" && pkg.engines.node.includes("22"), "engines.node missing or invalid");
  assert(pkg.license === "MIT", "package.json license must be MIT");
  assert(Array.isArray(pkg.files) && pkg.files.length > 0, "package.json files allowlist missing");
  assert(Boolean(pkg.scripts?.["package:check"]), "package:check script missing");
  assert(Boolean(pkg.scripts?.["phase13d:check"]), "phase13d:check script missing");

  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert(readme.includes("npm run package:check"), "README missing package:check mention");

  const docsExamplesCombined = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "docs/mcp-clients.md"), "utf8"),
    readFile(path.join(repoRoot, "examples/mcp-config.generic.json"), "utf8"),
  ]);
  assert(!docsExamplesCombined.join("\n").includes("/Users/"), "docs/examples still contain local /Users path");

  const run = spawnSync("npm", ["run", "package:check"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  assert(run.status === 0, `npm run package:check failed: ${run.stderr || run.stdout}`);

  console.log("phase13d-check passed");
}

main().catch((error) => {
  console.error("phase13d-check failed", error);
  process.exit(1);
});
