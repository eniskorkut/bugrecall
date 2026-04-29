import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  const client = new Client({ name: "phase11a-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: [pmaPath], cwd });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function fixture(baseDir: string, name: string, packageJson: Record<string, unknown>, extraFiles: string[] = []): Promise<string> {
  const dir = path.join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
  for (const f of extraFiles) {
    await writeFile(path.join(dir, f), "", "utf8");
  }
  return dir;
}

async function checkOne(cwd: string): Promise<Record<string, unknown>> {
  return await withClientInCwd(cwd, async (client) => {
    const profile = parseToolText(await client.callTool({ name: "get_project_profile", arguments: {} }));
    return profile.profile as Record<string, unknown>;
  });
}

async function main(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "phase11a-"));
  try {
    const npmDir = await fixture(
      baseDir,
      "npm-app",
      {
        name: "npm-app",
        version: "1.0.0",
        scripts: {
          test: "vitest --run",
          lint: "eslint .",
          build: "vite build",
        },
      },
    );

    const pnpmDir = await fixture(
      baseDir,
      "pnpm-app",
      {
        name: "pnpm-app",
        version: "1.0.0",
        scripts: {
          test: "vitest --run",
          lint: "eslint .",
          typecheck: "tsc -p tsconfig.json --noEmit",
        },
      },
      ["pnpm-lock.yaml"],
    );

    const yarnDir = await fixture(
      baseDir,
      "yarn-app",
      {
        name: "yarn-app",
        version: "1.0.0",
        scripts: {
          test: "vitest --run",
          build: "vite build",
        },
      },
      ["yarn.lock"],
    );

    const npmProfile = await checkOne(npmDir);
    const pnpmProfile = await checkOne(pnpmDir);
    const yarnProfile = await checkOne(yarnDir);

    const ok =
      npmProfile.package_manager === "npm" &&
      npmProfile.test_command === "npm run test" &&
      npmProfile.lint_command === "npm run lint" &&
      npmProfile.build_command === "npm run build" &&
      npmProfile.typecheck_command === null &&
      pnpmProfile.package_manager === "pnpm" &&
      pnpmProfile.test_command === "pnpm run test" &&
      pnpmProfile.lint_command === "pnpm run lint" &&
      pnpmProfile.typecheck_command === "pnpm run typecheck" &&
      pnpmProfile.build_command === null &&
      yarnProfile.package_manager === "yarn" &&
      yarnProfile.test_command === "yarn test" &&
      yarnProfile.build_command === "yarn build" &&
      yarnProfile.lint_command === null &&
      yarnProfile.typecheck_command === null;

    console.error(
      JSON.stringify(
        {
          ok,
          npmProfile,
          pnpmProfile,
          yarnProfile,
        },
        null,
        2,
      ),
    );
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
