// Fails fast on a missing var -- but per-field, at first access, not at
// import time. This module is imported transitively by almost everything
// (db.ts, vertex.ts, paystack.ts), and a test or script that only needs one
// of those shouldn't have to fake up every unrelated secret just to import
// it. Each consumer still fails immediately when it actually reads the
// field it needs (e.g. db.ts throws on import because it reads
// env.databaseUrl at module scope to build its pool).
interface EnvSchema {
  databaseUrl: string;
  googleCloudProject: string;
  googleCloudLocation: string;
  vertexModel: string;
  paystackSecretKey: string;
  appBaseUrl: string;
}

const REQUIRED: Record<keyof EnvSchema, string> = {
  databaseUrl: "DATABASE_URL",
  googleCloudProject: "GOOGLE_CLOUD_PROJECT",
  googleCloudLocation: "GOOGLE_CLOUD_LOCATION",
  vertexModel: "VERTEX_MODEL",
  paystackSecretKey: "PAYSTACK_SECRET_KEY",
  appBaseUrl: "APP_BASE_URL",
};

const DEFAULTS: Partial<Record<keyof EnvSchema, string>> = {
  googleCloudLocation: "us-central1",
  vertexModel: "gemini-2.5-flash",
};

function readEnv(key: keyof EnvSchema): string {
  const varName = REQUIRED[key];
  const value = process.env[varName];
  if (value) return value;

  const fallback = DEFAULTS[key];
  if (fallback !== undefined) return fallback;

  throw new Error(`Missing required environment variable: ${varName}`);
}

export const env: EnvSchema = new Proxy({} as EnvSchema, {
  get(_target, prop: string) {
    return readEnv(prop as keyof EnvSchema);
  },
});
