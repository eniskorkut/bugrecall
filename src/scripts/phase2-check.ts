import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const client = new Client({ name: "phase2-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);

  const bootstrap = await client.callTool({ name: "bootstrap_project", arguments: {} });
  const postmortem = await client.callTool({
    name: "commit_postmortem",
    arguments: {
      type: "incident",
      scope: "workspace-only",
      content: "Phase2 smoke: test incident memory record",
      confidence: 0.91,
      metadata: {
        error_class: "SmokeCheckError",
        symptoms: ["phase2 validation"],
        root_cause: "test path",
        fix_pattern: "none",
        anti_patterns: [],
        verification_steps: ["run phase2 check"],
        workspace: "local",
        toolchain: "node",
        language: "typescript",
        files: ["src/index.ts"],
      },
    },
  });
  const records = await client.callTool({ name: "read_project_memory", arguments: { type: "incident", limit: 10 } });

  console.error(
    JSON.stringify(
      {
        ok: true,
        bootstrap,
        postmortem,
        records,
      },
      null,
      2,
    ),
  );

  await client.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
