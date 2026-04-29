import { createServer } from "node:net";
import { buildIdentityAndProfile, ensureStore } from "../index.js";
import { startDashboardServer } from "../dashboard/server.js";

async function randomPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("port_alloc_failed"));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const data = await buildIdentityAndProfile(cwd);
  const { store } = await ensureStore(data.agentRoot);
  try {
    store.upsertProject(data.identity);
    store.upsertProjectProfile(data.identity.project_id, data.profile);
    store.insertMemoryRecord(data.identity.project_id, {
      type: "incident",
      scope: "workspace-only",
      content: "pytest failure fixture",
      confidence: 0.9,
      metadata: { toolchain: "pytest", language: "python", error_class: "python_test_failure" },
    });
    store.insertMemoryRecord(data.identity.project_id, {
      type: "incident",
      scope: "workspace-only",
      content: "TS2322 fixture",
      confidence: 0.9,
      metadata: { toolchain: "tsc", language: "typescript", error_class: "typescript_type_error" },
    });
  } finally {
    store.close();
  }

  const port = await randomPort();
  const server = await startDashboardServer({ cwd, host: "127.0.0.1", port });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetchJson(`${base}/api/health`);
    const overview = await fetchJson(`${base}/api/overview`);
    const memories = await fetchJson(`${base}/api/memories?limit=10`);
    const search = await fetchJson(`${base}/api/search?q=pytest&mode=text&limit=5`);
    const vector = await fetchJson(`${base}/api/vectorization/status`);

    const ok =
      health.ok === true &&
      overview.ok === true &&
      Array.isArray(memories.records) &&
      search.ok === true &&
      vector.ok === true &&
      (server.host === "127.0.0.1" || server.host === "localhost");

    console.error(
      JSON.stringify(
        {
          ok,
          host: server.host,
          port: server.port,
          checks: {
            health: health.ok,
            overview: overview.ok,
            memories_count: Array.isArray(memories.records) ? memories.records.length : -1,
            search: search.ok,
            vector: vector.ok,
          },
        },
        null,
        2,
      ),
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await server.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
