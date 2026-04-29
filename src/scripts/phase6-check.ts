import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase6-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const result = await withClient(async (client) => {
    await client.callTool({ name: "bootstrap_project", arguments: {} });

    await client.callTool({
      name: "commit_postmortem",
      arguments: {
        type: "incident",
        scope: "workspace-only",
        content: "pytest failed with AssertionError in tests/test_api.py",
        confidence: 0.92,
        metadata: {
          error_class: "python_test_failure",
          toolchain: "pytest",
          language: "python",
          workspace: ".",
          files: ["tests/test_api.py"],
        },
      },
    });
    await client.callTool({
      name: "commit_postmortem",
      arguments: {
        type: "incident",
        scope: "workspace-only",
        content: "TS2322 type mismatch in src/example.ts",
        confidence: 0.91,
        metadata: {
          error_class: "typescript_type_error",
          toolchain: "tsc",
          language: "typescript",
          workspace: ".",
          files: ["src/example.ts"],
        },
      },
    });
    await client.callTool({
      name: "commit_postmortem",
      arguments: {
        type: "incident",
        scope: "workspace-only",
        content: "Next.js build failed to compile in app/page.tsx",
        confidence: 0.9,
        metadata: {
          error_class: "nextjs_error",
          toolchain: "nextjs",
          language: "typescript",
          workspace: ".",
          files: ["app/page.tsx"],
        },
      },
    });

    const vec = parseToolText(
      await client.callTool({ name: "vectorize_pending_memories", arguments: { limit: 20, retry_failed: false } }),
    );
    const idx = parseToolText(await client.callTool({ name: "index_ready_memories", arguments: { limit: 50 } }));

    const q1 = parseToolText(
      await client.callTool({
        name: "search_project_experience",
        arguments: { query: "pytest AssertionError", mode: "auto", limit: 5, filters: { toolchain: "pytest" } },
      }),
    );
    const q2 = parseToolText(
      await client.callTool({
        name: "search_project_experience",
        arguments: { query: "TS2322 type mismatch", mode: "hybrid", limit: 5, filters: { error_class: "typescript_type_error" } },
      }),
    );
    const q3 = parseToolText(
      await client.callTool({
        name: "search_project_experience",
        arguments: { query: "Next.js failed to compile", mode: "auto", limit: 5, filters: { toolchain: "nextjs" } },
      }),
    );
    const fallback = parseToolText(
      await client.callTool({
        name: "search_project_experience",
        arguments: { query: "TS2322", mode: "text", limit: 5 },
      }),
    );
    const status = parseToolText(await client.callTool({ name: "get_vectorization_status", arguments: {} }));
    const tools = await client.listTools();

    return { vec, idx, q1, q2, q3, fallback, status, tools };
  });

  const topHas = (payload: Record<string, unknown>, text: string): boolean => {
    const arr = Array.isArray(payload.results) ? (payload.results as Array<Record<string, unknown>>) : [];
    const top = arr[0];
    if (!top) return false;
    return String(top.content ?? "").toLowerCase().includes(text.toLowerCase());
  };

  const tools = (result.tools.tools ?? []).map((t: { name: string }) => t.name);
  const ok =
    Number(result.vec.processed_count ?? 0) >= 1 &&
    tools.includes("index_ready_memories") &&
    tools.includes("search_project_experience") &&
    Number(result.fallback.count ?? 0) >= 1 &&
    topHas(result.q1, "pytest") &&
    topHas(result.q2, "TS2322") &&
    topHas(result.q3, "Next.js");

  console.error(
    JSON.stringify(
      {
        ok,
        summary: {
          vector_search_enabled: result.status.vector_search_enabled,
          worker_state: result.status.worker_state,
          mode_used: {
            q1: result.q1.mode_used,
            q2: result.q2.mode_used,
            q3: result.q3.mode_used,
            fallback: result.fallback.mode_used,
          },
        },
        details: result,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
