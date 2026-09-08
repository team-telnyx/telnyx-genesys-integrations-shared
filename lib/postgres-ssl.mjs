import { readFileSync } from "node:fs";

function isEnabled(value) {
  return ["1", "true", "yes", "on", "require", "required"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function readOptionalFile(path) {
  return path ? readFileSync(path, "utf8") : undefined;
}

export function readPostgresSslConfig(env = process.env) {
  const mode = String(env.PGSSLMODE || env.POSTGRES_SSLMODE || "")
    .trim()
    .toLowerCase();
  const explicit = isEnabled(env.POSTGRES_SSL) || isEnabled(env.DATABASE_SSL);

  if (["disable", "disabled"].includes(mode)) return false;
  if (env.POSTGRES_SSL === "false" || env.DATABASE_SSL === "false") return false;

  const files = Object.fromEntries(
    Object.entries({
      ca: readOptionalFile(env.PGSSLROOTCERT),
      cert: readOptionalFile(env.PGSSLCERT),
      key: readOptionalFile(env.PGSSLKEY),
    }).filter(([, value]) => value !== undefined)
  );

  if (mode === "verify-full") {
    return { rejectUnauthorized: true, ...files };
  }
  if (mode === "verify-ca") {
    if (!files.ca) throw new Error("PGSSLROOTCERT is required for PGSSLMODE=verify-ca");
    return {
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
      ...files,
    };
  }
  if (explicit || ["require", "no-verify"].includes(mode)) {
    return {
      rejectUnauthorized: isEnabled(env.POSTGRES_SSL_REJECT_UNAUTHORIZED),
      ...files,
    };
  }
  return false;
}
