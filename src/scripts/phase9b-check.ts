import { createServer } from "node:net";
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

async function fetchAny(url: string): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await fetch(url);
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

async function main(): Promise<void> {
  const port = await randomPort();
  const srv = await startDashboardServer({ host: "127.0.0.1", port, cwd: process.cwd() });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const root = await fetchAny(`${base}/`);
    const health = await fetchAny(`${base}/api/health`);
    const overview = await fetchAny(`${base}/api/overview`);
    const memories = await fetchAny(`${base}/api/memories?limit=5`);
    const miss = await fetchAny(`${base}/api/not-found`);

    const ok =
      srv.host === "127.0.0.1" &&
      root.status === 200 &&
      typeof root.raw === "string" &&
      root.raw.includes("Bugrecall") &&
      health.status === 200 &&
      (health.body as Record<string, unknown>)?.ok === true &&
      overview.status === 200 &&
      (overview.body as Record<string, unknown>)?.ok === true &&
      memories.status === 200 &&
      Array.isArray((memories.body as Record<string, unknown>)?.records) &&
      miss.status === 404 &&
      typeof miss.body === "object" &&
      miss.body !== null;

    console.error(
      JSON.stringify(
        {
          ok,
          host: srv.host,
          port: srv.port,
          statuses: {
            root: root.status,
            health: health.status,
            overview: overview.status,
            memories: memories.status,
            missing: miss.status,
          },
        },
        null,
        2,
      ),
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await srv.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
