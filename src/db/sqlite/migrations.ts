import type Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";

export function runMigrations(db: Database.Database): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const getMigration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?");
  const recordMigration = db.prepare("INSERT INTO schema_migrations (id) VALUES (?)");
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    const existing = getMigration.get(migration.id) as { id: string } | undefined;
    if (existing) {
      continue;
    }

    const tx = db.transaction(() => {
      db.exec(migration.sql);
      recordMigration.run(migration.id);
    });
    tx();
    applied.push(migration.id);
  }

  return applied;
}
