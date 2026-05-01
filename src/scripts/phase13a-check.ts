import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");

  const readmePath = path.join(repoRoot, "README.md");
  const dogfoodPath = path.join(repoRoot, "docs", "dogfood.md");
  const clientsPath = path.join(repoRoot, "docs", "mcp-clients.md");
  const localDataPath = path.join(repoRoot, "docs", "local-data.md");
  const workflowsPath = path.join(repoRoot, "docs", "tool-workflows.md");
  const genericConfigPath = path.join(repoRoot, "examples", "mcp-config.generic.json");
  const promptsPath = path.join(repoRoot, "examples", "prompts.md");
  const doctorPath = path.join(repoRoot, "src", "scripts", "doctor.ts");
  const pkgPath = path.join(repoRoot, "package.json");

  assert(existsSync(readmePath), "README.md missing");
  const readme = readFileSync(readmePath, "utf8");
  assert(!readme.includes("No memory implementation yet"), "README still contains scaffold text");
  assert(readme.includes("Bugrecall"), "README does not mention Bugrecall");
  assert(readme.includes("127.0.0.1:1453"), "README missing dashboard URL");

  assert(existsSync(dogfoodPath), "docs/dogfood.md missing");
  assert(existsSync(clientsPath), "docs/mcp-clients.md missing");
  assert(existsSync(localDataPath), "docs/local-data.md missing");
  assert(existsSync(workflowsPath), "docs/tool-workflows.md missing");
  assert(existsSync(promptsPath), "examples/prompts.md missing");
  assert(existsSync(doctorPath), "src/scripts/doctor.ts missing");

  assert(existsSync(genericConfigPath), "examples/mcp-config.generic.json missing");
  JSON.parse(readFileSync(genericConfigPath, "utf8"));

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  assert(Boolean(pkg.scripts?.doctor), "package.json missing doctor script");
  assert(Boolean(pkg.scripts?.["phase13a:check"]), "package.json missing phase13a:check script");

  const doctorOutput = run("npm", ["run", "doctor"], repoRoot);
  assert(doctorOutput.includes("Bugrecall Doctor"), "doctor output missing header");
  assert(doctorOutput.includes("dashboard default"), "doctor output missing dashboard info");

  console.error(
    JSON.stringify(
      {
        ok: true,
        checked: [
          "README",
          "docs/*",
          "examples/*",
          "doctor script",
          "package scripts",
          "npm run doctor",
        ],
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
