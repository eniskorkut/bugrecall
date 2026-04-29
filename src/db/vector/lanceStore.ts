import path from "node:path";
import type { VectorIndexRow, VectorSearchFilters, VectorSearchHit, VectorStoreStatus } from "./types.js";

const TABLE_NAME = "memory_vectors";

type LanceModule = {
  connect: (uri: string) => Promise<{
    tableNames: () => Promise<string[]>;
    createTable: (name: string, data: unknown[]) => Promise<unknown>;
    openTable: (name: string) => Promise<unknown>;
    dropTable?: (name: string) => Promise<void>;
  }>;
};

type LanceTable = {
  add?: (rows: unknown[]) => Promise<void>;
  delete?: (where: string) => Promise<void>;
  search?: (vector: number[]) => { limit: (n: number) => { toArray: () => Promise<unknown[]> } };
};

let importError: string | null = null;

async function tryLoadLance(): Promise<LanceModule | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<unknown>;
    const mod = (await dynamicImport("@lancedb/lancedb")) as LanceModule;
    importError = null;
    return mod;
  } catch (error: unknown) {
    importError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export async function isVectorStoreAvailable(): Promise<boolean> {
  const mod = await tryLoadLance();
  return mod !== null;
}

export async function getVectorStoreStatus(): Promise<VectorStoreStatus> {
  const mod = await tryLoadLance();
  if (!mod) {
    return { state: "unavailable", enabled: false, reason: importError ?? "lancedb import failed" };
  }
  return { state: "available", enabled: true };
}

function getVectorPath(projectRoot: string): string {
  return path.join(projectRoot, ".agent", "lancedb");
}

async function getDb(projectRoot: string): Promise<{ db: Awaited<ReturnType<LanceModule["connect"]>>; status: VectorStoreStatus }> {
  const mod = await tryLoadLance();
  if (!mod) {
    return {
      db: null as never,
      status: { state: "unavailable", enabled: false, reason: importError ?? "lancedb import failed" },
    };
  }
  try {
    const db = await mod.connect(getVectorPath(projectRoot));
    return { db, status: { state: "available", enabled: true } };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { db: null as never, status: { state: "unavailable", enabled: false, reason } };
  }
}

export async function ensureVectorTable(
  projectRoot: string,
): Promise<{ ok: boolean; status: VectorStoreStatus; reason?: string }> {
  const ctx = await getDb(projectRoot);
  if (ctx.status.state !== "available") {
    return { ok: false, status: ctx.status, reason: ctx.status.reason };
  }
  try {
    const names = await ctx.db.tableNames();
    if (!names.includes(TABLE_NAME)) {
      await ctx.db.createTable(TABLE_NAME, []);
    }
    return { ok: true, status: ctx.status };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: { state: "unavailable", enabled: false, reason }, reason };
  }
}

export async function clearVectorTable(
  projectRoot: string,
): Promise<{ ok: boolean; status: VectorStoreStatus; reason?: string }> {
  const ctx = await getDb(projectRoot);
  if (ctx.status.state !== "available") return { ok: false, status: ctx.status, reason: ctx.status.reason };
  try {
    const names = await ctx.db.tableNames();
    if (names.includes(TABLE_NAME) && ctx.db.dropTable) {
      await ctx.db.dropTable(TABLE_NAME);
    }
    await ctx.db.createTable(TABLE_NAME, []);
    return { ok: true, status: ctx.status };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: { state: "unavailable", enabled: false, reason }, reason };
  }
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function clearVectorProject(
  projectRoot: string,
  projectId: string,
): Promise<{ ok: boolean; status: VectorStoreStatus; reason?: string }> {
  const tableState = await ensureVectorTable(projectRoot);
  if (!tableState.ok) return { ok: false, status: tableState.status, reason: tableState.reason };
  try {
    const ctx = await getDb(projectRoot);
    if (ctx.status.state !== "available") return { ok: false, status: ctx.status, reason: ctx.status.reason };
    const table = (await ctx.db.openTable(TABLE_NAME)) as LanceTable;
    if (!table.delete) {
      return {
        ok: false,
        status: ctx.status,
        reason: "project_scoped_vector_clear_unavailable",
      };
    }
    await table.delete(`project_id = ${sqlQuote(projectId)}`);
    return { ok: true, status: ctx.status };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: { state: "unavailable", enabled: false, reason }, reason };
  }
}

export async function upsertVectors(
  projectRoot: string,
  rows: VectorIndexRow[],
): Promise<{ indexed_count: number; failed_count: number; status: VectorStoreStatus; reason?: string }> {
  const tableState = await ensureVectorTable(projectRoot);
  if (!tableState.ok) {
    return {
      indexed_count: 0,
      failed_count: rows.length,
      status: tableState.status,
      reason: tableState.reason,
    };
  }
  if (rows.length === 0) {
    return { indexed_count: 0, failed_count: 0, status: tableState.status };
  }
  try {
    const ctx = await getDb(projectRoot);
    if (ctx.status.state !== "available") {
      return {
        indexed_count: 0,
        failed_count: rows.length,
        status: ctx.status,
        reason: ctx.status.reason,
      };
    }
    const table = (await ctx.db.openTable(TABLE_NAME)) as LanceTable;
    if (!table.add) {
      return {
        indexed_count: 0,
        failed_count: rows.length,
        status: { state: "unavailable", enabled: false, reason: "lancedb table.add unavailable" },
      };
    }
    if (table.delete) {
      for (const row of rows) {
        await table.delete(`id = ${sqlQuote(row.id)}`);
      }
    }
    await table.add(rows);
    return { indexed_count: rows.length, failed_count: 0, status: ctx.status };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      indexed_count: 0,
      failed_count: rows.length,
      status: { state: "unavailable", enabled: false, reason },
      reason,
    };
  }
}

export async function searchVectors(
  projectRoot: string,
  projectId: string,
  queryVector: number[],
  filters: VectorSearchFilters,
  limit: number,
): Promise<{ hits: VectorSearchHit[]; status: VectorStoreStatus; reason?: string }> {
  const tableState = await ensureVectorTable(projectRoot);
  if (!tableState.ok) return { hits: [], status: tableState.status, reason: tableState.reason };
  try {
    const ctx = await getDb(projectRoot);
    if (ctx.status.state !== "available") return { hits: [], status: ctx.status, reason: ctx.status.reason };
    const table = (await ctx.db.openTable(TABLE_NAME)) as LanceTable;
    if (!table.search) {
      return {
        hits: [],
        status: { state: "unavailable", enabled: false, reason: "lancedb table.search unavailable" },
      };
    }
    const raw = await table.search(queryVector).limit(Math.max(1, Math.min(100, limit * 5))).toArray();
    const hits = (raw as Array<Record<string, unknown>>)
      .filter((row) => String(row.project_id ?? "") === projectId)
      .filter((row) => (filters.type ? String(row.type ?? "") === filters.type : true))
      .filter((row) => (filters.workspace ? String(row.workspace ?? "") === filters.workspace : true))
      .filter((row) => (filters.toolchain ? String(row.toolchain ?? "") === filters.toolchain : true))
      .filter((row) => (filters.language ? String(row.language ?? "") === filters.language : true))
      .filter((row) => (filters.error_class ? String(row.error_class ?? "") === filters.error_class : true))
      .map((row) => {
        const distance = Number(row._distance ?? row.distance ?? 0);
        const score = Number.isFinite(distance) ? 1 / (1 + Math.max(0, distance)) : 0;
        return {
          id: String(row.id),
          score,
          source: "vector" as const,
        };
      })
      .slice(0, limit);
    return { hits, status: ctx.status };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { hits: [], status: { state: "unavailable", enabled: false, reason }, reason };
  }
}
