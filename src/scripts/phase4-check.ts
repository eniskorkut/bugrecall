import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const client = new Client({ name: "phase4-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);

  await client.callTool({ name: "bootstrap_project", arguments: {} });

  await client.callTool({
    name: "commit_postmortem",
    arguments: {
      type: "incident",
      scope: "workspace-only",
      content: "Pytest failed due to AssertionError in tests/test_api.py",
      confidence: 0.91,
      metadata: {
        workspace: ".",
        toolchain: "pytest",
        language: "python",
        error_class: "python_test_failure",
      },
    },
  });

  await client.callTool({
    name: "commit_postmortem",
    arguments: {
      type: "incident",
      scope: "workspace-only",
      content: "TS2322 type mismatch in src/example.ts",
      confidence: 0.93,
      metadata: {
        workspace: ".",
        toolchain: "tsc",
        language: "typescript",
        error_class: "typescript_type_error",
      },
    },
  });

  await client.callTool({
    name: "commit_postmortem",
    arguments: {
      type: "incident",
      scope: "workspace-only",
      content: "Next.js build failed to compile app/page.tsx",
      confidence: 0.9,
      metadata: {
        workspace: ".",
        toolchain: "nextjs",
        language: "typescript",
        error_class: "nextjs_error",
      },
    },
  });

  const q1 = parseToolText(
    await client.callTool({
      name: "search_project_experience",
      arguments: {
        query: "pytest assertion failure",
        filters: { toolchain: "pytest", error_class: "python_test_failure" },
        limit: 3,
      },
    }),
  );
  const q2 = parseToolText(
    await client.callTool({
      name: "search_project_experience",
      arguments: {
        query: "TS2322 type mismatch",
        filters: { toolchain: "tsc", error_class: "typescript_type_error" },
        limit: 3,
      },
    }),
  );
  const q3 = parseToolText(
    await client.callTool({
      name: "search_project_experience",
      arguments: {
        query: "next build failed compile app",
        filters: { toolchain: "nextjs", error_class: "nextjs_error" },
        limit: 3,
      },
    }),
  );

  const top1 = ((q1.results as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
  const top2 = ((q2.results as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
  const top3 = ((q3.results as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};

  const pass =
    String((top1.metadata as Record<string, unknown> | undefined)?.toolchain ?? "") === "pytest" &&
    String((top2.metadata as Record<string, unknown> | undefined)?.toolchain ?? "") === "tsc" &&
    String((top3.metadata as Record<string, unknown> | undefined)?.toolchain ?? "") === "nextjs" &&
    Number(top1.score ?? 0) > 0 &&
    Number(top2.score ?? 0) > 0 &&
    Number(top3.score ?? 0) > 0 &&
    Number(top1.retrieval_hits ?? 0) >= 1 &&
    Number(top2.retrieval_hits ?? 0) >= 1 &&
    Number(top3.retrieval_hits ?? 0) >= 1;

  console.error(
    JSON.stringify(
      {
        ok: pass,
        q1_top: top1,
        q2_top: top2,
        q3_top: top3,
      },
      null,
      2,
    ),
  );

  await client.close();
  if (!pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
