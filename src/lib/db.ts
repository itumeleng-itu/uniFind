import { Pool } from "pg";
import { env } from "./env";

let pool: Pool | null = null;

// Lazy singleton: Next.js imports every route module to collect page data
// at build time, before any real request happens and before DATABASE_URL
// is necessarily present (Cloud Build builds the image before Cloud Run
// injects runtime secrets). Constructing the pool eagerly at import time
// would fail the build itself instead of failing at first real use.
//
// Cloud Run scales horizontally by adding instances, not by growing one
// instance's connection count -- a large per-instance pool just multiplies
// against Postgres's max_connections as traffic grows. Keep this small.
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}
