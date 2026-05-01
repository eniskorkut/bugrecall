import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const scriptFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptFile);
  const repoRoot = path.resolve(scriptDir, "../..");

  const integrationFiles = [
    "docs/integrations/generic-mcp.md",
    "docs/integrations/codex.md",
    "docs/integrations/claude.md",
    "docs/integrations/cursor.md",
    "docs/integrations/agent-instructions.md",
    "docs/integrations/troubleshooting.md",
  ];
  for (const rel of integrationFiles) {
    assert(existsSync(path.join(repoRoot, rel)), `${rel} missing`);
  }

  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert(readme.includes("docs/integrations/"), "README does not link integrations docs");

  const mcpClients = readFileSync(path.join(repoRoot, "docs/mcp-clients.md"), "utf8");
  assert(mcpClients.includes("integrations/generic-mcp.md"), "docs/mcp-clients.md missing generic integration link");
  assert(mcpClients.includes("integrations/codex.md"), "docs/mcp-clients.md missing codex integration link");
  assert(mcpClients.includes("integrations/claude.md"), "docs/mcp-clients.md missing claude integration link");
  assert(mcpClients.includes("integrations/cursor.md"), "docs/mcp-clients.md missing cursor integration link");
  assert(mcpClients.includes("integrations/agent-instructions.md"), "docs/mcp-clients.md missing agent instructions link");
  assert(mcpClients.includes("integrations/troubleshooting.md"), "docs/mcp-clients.md missing troubleshooting link");

  const exampleFiles = [
    "examples/agent-instruction-full.md",
    "examples/agent-instruction-minimal.md",
    "examples/agent-instruction-monorepo.md",
    "examples/mcp-config.with-env.json",
  ];
  for (const rel of exampleFiles) {
    assert(existsSync(path.join(repoRoot, rel)), `${rel} missing`);
  }
  JSON.parse(readFileSync(path.join(repoRoot, "examples/mcp-config.with-env.json"), "utf8"));

  const docExampleContent = [
    readme,
    mcpClients,
    ...integrationFiles.map((rel) => readFileSync(path.join(repoRoot, rel), "utf8")),
    ...exampleFiles.map((rel) => readFileSync(path.join(repoRoot, rel), "utf8")),
  ].join("\n");

  assert(!docExampleContent.includes("/Users/"), "docs/examples contain local /Users/ path");
  assert(!docExampleContent.includes("project-memory-agent/bin/pma.js"), "docs/examples contain outdated nested bin path");
  assert(docExampleContent.includes("/absolute/path/to/bugrecall/bin/pma.js"), "integration docs missing absolute bugrecall bin path template");

  const agentInstructions = readFileSync(path.join(repoRoot, "docs/integrations/agent-instructions.md"), "utf8");
  const requiredTokens = [
    "bootstrap_project",
    "search_project_experience",
    "get_memory_detail",
    "finalize_successful_fix",
    "record_user_correction",
    "rejected_fix",
    "workspace_path",
  ];
  for (const token of requiredTokens) {
    assert(agentInstructions.includes(token), `agent instructions missing ${token}`);
  }

  console.error(
    JSON.stringify(
      {
        ok: true,
        checked: [
          "integration docs",
          "README links",
          "docs/mcp-clients index links",
          "integration examples",
          "no local absolute paths",
          "agent instruction required tokens",
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
