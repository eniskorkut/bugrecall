import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./routes.js";

export type DashboardOptions = {
  cwd?: string;
  host?: string;
  port?: number;
};

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function resolveHost(input?: string): string {
  const host = (input ?? process.env.BUGRECALL_DASHBOARD_HOST ?? "127.0.0.1").trim();
  const allowRemote = process.env.BUGRECALL_DASHBOARD_ALLOW_REMOTE === "1";
  if (!allowRemote && !isLocalHost(host)) {
    throw new Error(`Non-local host rejected: ${host}. Set BUGRECALL_DASHBOARD_ALLOW_REMOTE=1 to override.`);
  }
  return host;
}

function resolvePort(input?: number): number {
  const env = process.env.BUGRECALL_DASHBOARD_PORT;
  const n = input ?? (env ? Number.parseInt(env, 10) : 1453);
  if (!Number.isFinite(n)) return 1453;
  return Math.max(1, Math.min(65535, n));
}

function isAllowedHostHeader(rawHost: string | undefined): boolean {
  if (!rawHost) return true;
  const host = rawHost.split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function getStaticFilePath(urlPath: string): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "static"), path.resolve(here, "../../src/dashboard/static")];
  const requestPath = urlPath === "/" ? "/index.html" : urlPath;
  for (const dir of candidates) {
    const full = path.resolve(dir, `.${requestPath}`);
    const rel = path.relative(dir, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!existsSync(full)) continue;
    return full;
  }
  return null;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function startDashboardServer(options: DashboardOptions = {}): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const cwd = options.cwd ?? process.cwd();
  const host = resolveHost(options.host);
  const port = resolvePort(options.port);

  const server = createServer(async (req, res) => {
    try {
      if (!isAllowedHostHeader(req.headers.host)) {
        return sendJson(res, 403, { ok: false, reason: "host_header_rejected" });
      }
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname.startsWith("/api/")) {
        const bodyRaw = method === "POST" ? await readBody(req) : "";
        const out = await handleApiRequest(cwd, method, url.pathname, url, bodyRaw);
        return sendJson(res, out.status, out.body);
      }

      const staticPath = getStaticFilePath(url.pathname);
      if (!staticPath) return sendJson(res, 404, { ok: false, reason: "not_found" });
      const file = await readFile(staticPath).catch(() => null);
      if (!file) return sendJson(res, 404, { ok: false, reason: "not_found" });
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType(staticPath));
      res.end(file);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[dashboard] request error: ${message}`);
      sendJson(res, 500, { ok: false, reason: "internal_error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  console.error(`Dashboard listening on http://${host}:${port}`);
  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
