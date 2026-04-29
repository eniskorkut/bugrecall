import { startMcpServer } from "./index.js";
import { startDashboardServer } from "./dashboard/server.js";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "dashboard") {
    await startDashboardServer({ cwd: process.cwd() });
    return;
  }
  await startMcpServer();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[pma] fatal error:", message);
  process.exit(1);
});
