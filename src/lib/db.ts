import { Pool } from "pg";
import { env } from "./env";

// Cloud Run scales horizontally by adding instances, not by growing one
// instance's connection count -- a large per-instance pool just multiplies
// against Postgres's max_connections as traffic grows. Keep this small.
export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
