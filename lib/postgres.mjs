import { Pool } from "pg";
import { readPostgresSslConfig } from "./postgres-ssl.mjs";

const cache =
  globalThis.__telnyxGenesysPostgres ||
  (globalThis.__telnyxGenesysPostgres = { pool: null, status: "disconnected" });

function integerFromEnv(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function connectionConfig(env = process.env) {
  const connectionString = String(env.DATABASE_URL || "").trim();
  if (connectionString) return { connectionString };

  const host = String(env.POSTGRES_HOST || "").trim();
  const database = String(env.POSTGRES_DB || "").trim();
  const user = String(env.POSTGRES_USER || "").trim();
  if (!host || !database || !user) {
    throw new Error(
      "PostgreSQL is required. Configure DATABASE_URL or POSTGRES_HOST, POSTGRES_DB and POSTGRES_USER."
    );
  }

  return {
    host,
    port: integerFromEnv(env.POSTGRES_PORT, 5432, "POSTGRES_PORT"),
    database,
    user,
    password: env.POSTGRES_PASSWORD || "",
  };
}

export function isPostgresConfigured(env = process.env) {
  if (String(env.DATABASE_URL || "").trim()) return true;
  return ["POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER"].every(
    (name) => String(env[name] || "").trim()
  );
}

export function getPostgresPool() {
  if (cache.pool) return cache.pool;

  const pool = new Pool({
    ...connectionConfig(),
    ssl: readPostgresSslConfig(),
    max: integerFromEnv(process.env.POSTGRES_POOL_MAX, 10, "POSTGRES_POOL_MAX"),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    allowExitOnIdle: true,
    application_name:
      process.env.POSTGRES_APPLICATION_NAME || "telnyx-genesys-integrations",
  });

  pool.on("connect", () => {
    cache.status = "connected";
  });
  pool.on("error", (error) => {
    cache.status = "disconnected";
    console.error("[postgres] pool error:", error?.message || error);
  });

  cache.pool = pool;
  return pool;
}

export async function checkPostgresStatus() {
  try {
    cache.status = "connecting";
    const result = await getPostgresPool().query("SELECT 1 AS ok");
    cache.status = "connected";
    return { ready: result.rows[0]?.ok === 1, status: cache.status };
  } catch (error) {
    cache.status = "disconnected";
    return {
      ready: false,
      status: cache.status,
      error: error?.message || String(error),
    };
  }
}

export async function closePostgresPool() {
  if (!cache.pool) return;
  const pool = cache.pool;
  cache.pool = null;
  cache.status = "disconnecting";
  await pool.end();
  cache.status = "disconnected";
}
