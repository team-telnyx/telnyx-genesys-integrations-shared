#!/usr/bin/env node

import "dotenv/config";
import { closePostgresPool } from "../lib/postgres.mjs";
import { ensurePostgresSchema } from "../lib/postgres-schema.mjs";

try {
  const result = await ensurePostgresSchema();
  console.log(`[ensure-pg] schema ensured at version ${result.version}`);
} catch (error) {
  console.error("[ensure-pg] failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await closePostgresPool().catch((error) => {
    console.error("[ensure-pg] failed to close pool:", error?.message || error);
    process.exitCode = 1;
  });
}
