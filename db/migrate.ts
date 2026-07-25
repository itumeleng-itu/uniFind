import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// Both `pg`'s Pool/Client and PGlite expose an `exec`-shaped multi-statement
// runner (pg via `.query(sql)` with no params, PGlite via `.exec(sql)`), so
// migrations apply the same way against production Postgres and the
// in-memory test database.
export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
}

export async function applyMigrations(db: SqlExecutor): Promise<void> {
  for (const file of migrationFiles()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    await db.exec(sql);
  }
}
