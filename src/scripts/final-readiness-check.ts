import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type PackageJson = {
  private?: boolean;
  version?: string;
  license?: string;
  files?: string[];
  scripts?: Record<string, string>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        out.push(rel + "/");
        await walk(abs);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(root);
  return out;
}

async function main() {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");

  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;

  assert(pkg.private === true, "package private must be true");
  assert(typeof pkg.version === "string" && pkg.version.length > 0, "package version missing");
  assert(pkg.license === "MIT", "package license must be MIT");

  const mustExist = [
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
    "docs/release.md",
    "docs/status.md",
    "docs/integrations/codex.md",
    "docs/integrations/claude.md",
    "docs/integrations/cursor.md",
    "eval/retrieval/basic-debug-memory.json",
  ];
  for (const rel of mustExist) {
    assert(existsSync(path.join(repoRoot, rel)), `missing required file: ${rel}`);
  }

  const requiredScripts = [
    "build",
    "typecheck",
    "doctor",
    "phase13a:check",
    "phase13b:check",
    "phase13c:check",
    "phase13d:check",
    "phase12e:check",
    "eval:retrieval",
    "package:check",
    "final:check",
  ];
  for (const script of requiredScripts) {
    assert(Boolean(pkg.scripts?.[script]), `missing package script: ${script}`);
  }

  const noLeakTargets = [
    "README.md",
    "docs",
    "examples",
    "package.json",
    ".github/workflows/ci.yml",
  ];
  let combined = "";
  for (const target of noLeakTargets) {
    const abs = path.join(repoRoot, target);
    if (!existsSync(abs)) {
      continue;
    }
    const statFiles = await listFilesRecursive(abs).catch(() => []);
    if (
      statFiles.length === 0 &&
      (target.endsWith(".md") || target.endsWith(".json") || target.endsWith(".yml"))
    ) {
      combined += "\n" + (await readFile(abs, "utf8"));
    } else if (statFiles.length > 0) {
      for (const rel of statFiles) {
        if (rel.endsWith("/")) continue;
        const text = await readFile(path.join(abs, rel), "utf8");
        combined += "\n" + text;
      }
    }
  }
  assert(!combined.includes("/Users/"), "local /Users/ path leak found");
  assert(!combined.includes("project-memory-agent/bin/pma.js"), "outdated nested bin path found");

  const requiredAllowlist = [
    "bin",
    "dist",
    "examples",
    "docs",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
  ];
  assert(Array.isArray(pkg.files), "package files allowlist missing");
  for (const item of requiredAllowlist) {
    assert(pkg.files.includes(item), `package files missing allowlist item: ${item}`);
  }

  const examplesGeneric = JSON.parse(await readFile(path.join(repoRoot, "examples/mcp-config.generic.json"), "utf8"));
  const examplesEnv = JSON.parse(await readFile(path.join(repoRoot, "examples/mcp-config.with-env.json"), "utf8"));
  const genericPath = String(examplesGeneric?.mcpServers?.bugrecall?.args?.[0] ?? "");
  const envPath = String(examplesEnv?.mcpServers?.bugrecall?.args?.[0] ?? "");
  assert(genericPath.includes("/absolute/path/to/bugrecall/bin/pma.js"), "generic mcp config path mismatch");
  assert(envPath.includes("/absolute/path/to/bugrecall/bin/pma.js"), "env mcp config path mismatch");

  const docsText = await readFile(path.join(repoRoot, "docs/integrations/agent-instructions.md"), "utf8");
  const mustMention = [
    "bootstrap_project",
    "search_project_experience",
    "finalize_successful_fix",
    "record_user_correction",
    "workspace_path",
  ];
  for (const token of mustMention) {
    assert(docsText.includes(token), `integration docs missing token: ${token}`);
  }

  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const localData = await readFile(path.join(repoRoot, "docs/local-data.md"), "utf8");
  assert(readme.includes("http://127.0.0.1:1453"), "README missing dashboard URL");
  assert(localData.toLowerCase().includes("local-only") || localData.includes("127.0.0.1"), "local-data missing local-only note");
  assert(localData.includes(".gitignore"), "local-data missing gitignore note");

  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: path.join(repoRoot, ".tmp", "npm-cache"),
      npm_config_cache: path.join(repoRoot, ".tmp", "npm-cache"),
    },
  });
  assert(pack.status === 0, `npm pack dry-run failed: ${pack.stderr || pack.stdout}`);
  const parsed = JSON.parse(pack.stdout);
  const packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  const packaged = Array.isArray(packInfo?.files) ? packInfo.files.map((f: { path?: string }) => String(f.path ?? "")) : [];
  const forbiddenPackaged = [".agent", ".db", ".env", "node_modules", "coverage", ".git"];
  for (const file of packaged) {
    for (const forbidden of forbiddenPackaged) {
      assert(!file.includes(forbidden), `forbidden packaged file: ${file}`);
    }
  }

  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert(tracked.status === 0, "git ls-files failed");
  const trackedFiles = tracked.stdout.split("\n").filter(Boolean);
  const forbiddenTracked = [/\.agent\//, /memory\.db$/, /\.sqlite$/i, /\.sqlite3$/i];
  for (const file of trackedFiles) {
    for (const rule of forbiddenTracked) {
      assert(!rule.test(file), `forbidden tracked artifact: ${file}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        status: "mvp_ready_private_package",
        version: pkg.version,
        package_private: pkg.private === true,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("final:check failed", error);
  process.exit(1);
});
