import Database from "better-sqlite3";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const safe = result as { content?: Array<{ type?: string; text?: string }> };
  const text = safe.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "phase7-check", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: "node", args: ["bin/pma.js"] });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const fixtureDir = path.join(root, ".agent", "phase7-fixtures");
  const fixtureRel = ".agent/phase7-fixtures/test.txt";
  const fixtureAbs = path.join(root, fixtureRel);

  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });
  const original = ["start", "alpha", "middle", "alpha", "end"].join("\n");
  await writeFile(fixtureAbs, original, "utf8");

  const result = await withClient(async (client) => {
    await client.callTool({ name: "bootstrap_project", arguments: {} });

    const valid = parseToolText(
      await client.callTool({
        name: "apply_search_replace_patch",
        arguments: {
          file_path: fixtureRel,
          search_block: "middle",
          replace_block: "middle-patched",
        },
      }),
    );

    const afterPatch = await readFile(fixtureAbs, "utf8");

    const snapshotId = String(valid.snapshot_id ?? "");
    const db = new Database(path.join(root, ".agent", "memory.db"));
    const snapshotRow = snapshotId
      ? (db.prepare("SELECT id FROM snapshots WHERE id = ?").get(snapshotId) as { id: string } | undefined)
      : undefined;
    db.close();

    const restore = parseToolText(
      await client.callTool({
        name: "restore_snapshot",
        arguments: { snapshot_id: snapshotId },
      }),
    );
    const afterRestore = await readFile(fixtureAbs, "utf8");

    const noMatch = parseToolText(
      await client.callTool({
        name: "apply_search_replace_patch",
        arguments: {
          file_path: fixtureRel,
          search_block: "does-not-exist",
          replace_block: "x",
        },
      }),
    );

    const multi = parseToolText(
      await client.callTool({
        name: "apply_search_replace_patch",
        arguments: {
          file_path: fixtureRel,
          search_block: "alpha",
          replace_block: "alpha-patched",
        },
      }),
    );

    const abs = parseToolText(
      await client.callTool({
        name: "apply_search_replace_patch",
        arguments: {
          file_path: fixtureAbs,
          search_block: "start",
          replace_block: "begin",
        },
      }),
    );

    const traversal = parseToolText(
      await client.callTool({
        name: "apply_search_replace_patch",
        arguments: {
          file_path: "../package.json",
          search_block: "{",
          replace_block: "{",
        },
      }),
    );

    return { valid, afterPatch, snapshotRow, restore, afterRestore, noMatch, multi, abs, traversal };
  });

  const ok =
    result.valid.success === true &&
    result.valid.match_count === 1 &&
    result.afterPatch.includes("middle-patched") &&
    !!result.snapshotRow &&
    result.restore.success === true &&
    result.afterRestore === original &&
    result.noMatch.success === false &&
    result.noMatch.reason === "no_exact_match" &&
    result.multi.success === false &&
    result.multi.reason === "multiple_matches" &&
    result.abs.success === false &&
    result.abs.reason === "absolute_path_rejected" &&
    result.traversal.success === false &&
    result.traversal.reason === "path_traversal_rejected";

  console.error(JSON.stringify({ ok, result }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
