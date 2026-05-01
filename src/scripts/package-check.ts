import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type PackageJson = {
  private?: boolean;
  version?: string;
  bin?: Record<string, string>;
  files?: string[];
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

  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;

  assert(pkg.private === true, "package.json private must be true");
  assert(typeof pkg.version === "string" && pkg.version.length > 0, "package.json version missing");
  assert(pkg.bin?.pma === "./bin/pma.js", "bin.pma must point to ./bin/pma.js");
  assert(Array.isArray(pkg.files), "package.json files allowlist missing");

  const expectedFiles = [
    "bin",
    "dist",
    "examples",
    "docs",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
  ];

  for (const entry of expectedFiles) {
    assert(pkg.files.includes(entry), `files allowlist missing: ${entry}`);
  }

  const mustExist = [
    "bin/pma.js",
    "dist",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
    "docs/release.md",
    "examples/mcp-config.generic.json",
  ];
  for (const rel of mustExist) {
    const abs = path.join(repoRoot, rel);
    assert(existsSync(abs), `required path missing: ${rel}`);
  }

  const README = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert(!README.includes("/Users/"), "README contains local /Users path");

  const genericConfigRaw = await readFile(path.join(repoRoot, "examples/mcp-config.generic.json"), "utf8");
  const genericConfig = JSON.parse(genericConfigRaw);
  assert(genericConfig?.mcpServers?.bugrecall, "examples/mcp-config.generic.json missing bugrecall server");

  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: path.join(repoRoot, ".tmp", "npm-cache"),
      npm_config_cache: path.join(repoRoot, ".tmp", "npm-cache"),
    },
  });
  assert(pack.status === 0, `npm pack --dry-run failed: ${pack.stderr || pack.stdout}`);
  const parsed = JSON.parse(pack.stdout);
  const packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = Array.isArray(packInfo?.files) ? packInfo.files.map((f: { path?: string }) => String(f.path ?? "")) : [];

  const forbiddenSnippets = [".agent", "memory.db", ".env", "node_modules", "coverage", ".git"];
  for (const file of files) {
    for (const forbidden of forbiddenSnippets) {
      assert(!file.includes(forbidden), `forbidden packaged file path detected: ${file}`);
    }
  }

  const fileCount = typeof packInfo?.entryCount === "number" ? packInfo.entryCount : files.length;
  const unpacked = packInfo?.unpackedSize ?? "unknown";
  console.log(JSON.stringify({ ok: true, file_count: fileCount, unpacked_size: unpacked }, null, 2));
}

main().catch((error) => {
  console.error("package:check failed", error);
  process.exit(1);
});
