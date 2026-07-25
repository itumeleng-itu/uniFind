// Minimal query surface shared by pg's Pool/Client and PGlite, so the same
// business logic runs unchanged against production Postgres and the
// in-memory test database.
export interface DbClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
