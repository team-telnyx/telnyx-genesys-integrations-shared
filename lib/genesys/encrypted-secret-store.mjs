import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { getPostgresPool, isPostgresConfigured } from "../postgres.mjs";

const ALGORITHM = "aes-256-gcm";
const AAD_PREFIX = "telnyx-genesys-integrations:runtime-secret:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export const ADMIN_SECRETS_MASTER_KEY = "ADMIN_SECRETS_MASTER_KEY";

export const MANAGED_RUNTIME_SECRET_NAMES = Object.freeze([
  "GC_INSTALLATION_KEY",
  "GC_INSTALLATION_NAME",
  "GC_ENVIRONMENT",
  "GC_PUBLIC_BASE_URL",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "GC_CLIENT_ID",
  "GC_CLIENT_SECRET",
  "GC_ORGANIZATION_ID",
  "GC_WIDGET_ADMIN_GROUP_ID",
  "GC_WIDGET_ADMIN_ROLE_ID",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  "WIDGET_SESSION_SIGNING_SECRET",
  "WIDGET_HANDOFF_API_KEY",
  "GENESYS_HANDOFF_API_KEY",
  "GC_OPEN_MESSAGING_SECRET",
  "GC_OPEN_MESSAGING_SECRETS_JSON",
  "GC_AUDIO_CONNECTOR_API_KEY",
  "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
  "GC_AUDIO_HANDOFF_API_KEY",
  "GC_SECRET_TOKEN",
]);

const managedNames = new Set(MANAGED_RUNTIME_SECRET_NAMES);
const runtimeCache =
  globalThis.__telnyxGenesysRuntimeSecrets ||
  (globalThis.__telnyxGenesysRuntimeSecrets = {
    values: null,
    loadPromise: null,
  });

function assertManagedName(name) {
  const normalized = String(name || "").trim();
  if (!managedNames.has(normalized)) {
    throw new Error(`Secret name ${normalized || "<empty>"} is not managed`);
  }
  return normalized;
}

export function encryptedSecretStoreConfigured(environment = process.env) {
  return isPostgresConfigured(environment) &&
    Boolean(String(environment[ADMIN_SECRETS_MASTER_KEY] || "").trim());
}

export function partitionManagedRuntimeValues(values = {}) {
  const managed = {};
  const plaintext = {};
  for (const [name, value] of Object.entries(values)) {
    (managedNames.has(name) ? managed : plaintext)[name] = value;
  }
  return { managed, plaintext };
}

export function decodeSecretsMasterKey(value = process.env[ADMIN_SECRETS_MASTER_KEY]) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(
      `${ADMIN_SECRETS_MASTER_KEY} is required; generate one with 32 random bytes encoded as base64`
    );
  }
  let key;
  if (/^[a-fA-F0-9]{64}$/.test(normalized)) {
    key = Buffer.from(normalized, "hex");
  } else {
    try {
      key = Buffer.from(normalized, "base64");
    } catch {
      key = Buffer.alloc(0);
    }
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`${ADMIN_SECRETS_MASTER_KEY} must decode to exactly 32 bytes`);
  }
  return key;
}

export function generateSecretsMasterKey() {
  return randomBytes(KEY_BYTES).toString("base64");
}

function additionalData(name) {
  return Buffer.from(`${AAD_PREFIX}${assertManagedName(name)}`, "utf8");
}

export function encryptSecretValue(name, value, masterKey = decodeSecretsMasterKey()) {
  const plaintext = String(value ?? "");
  if (!plaintext) throw new Error(`Secret ${name} cannot be empty`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  cipher.setAAD(additionalData(name));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext,
    initializationVector: iv,
    authenticationTag: cipher.getAuthTag(),
    keyVersion: 1,
  };
}

export function decryptSecretValue(name, encrypted, masterKey = decodeSecretsMasterKey()) {
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey,
    Buffer.from(encrypted.initializationVector)
  );
  decipher.setAAD(additionalData(name));
  decipher.setAuthTag(Buffer.from(encrypted.authenticationTag));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export async function saveEncryptedRuntimeSecrets(values, { masterKey } = {}) {
  const entries = Object.entries(values || {})
    .filter(([, value]) => String(value ?? "").trim())
    .map(([name, value]) => [assertManagedName(name), String(value)]);
  if (!entries.length) return { saved: 0 };
  const key = masterKey || decodeSecretsMasterKey();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    for (const [name, value] of entries) {
      const encrypted = encryptSecretValue(name, value, key);
      await client.query(
        `INSERT INTO integration_runtime_secrets
          (name, ciphertext, initialization_vector, authentication_tag, key_version)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (name) DO UPDATE SET
           ciphertext=EXCLUDED.ciphertext,
           initialization_vector=EXCLUDED.initialization_vector,
           authentication_tag=EXCLUDED.authentication_tag,
           key_version=EXCLUDED.key_version,
           updated_at=NOW()`,
        [
          name,
          encrypted.ciphertext,
          encrypted.initializationVector,
          encrypted.authenticationTag,
          encrypted.keyVersion,
        ]
      );
    }
    await client.query("COMMIT");
    runtimeCache.values = { ...(runtimeCache.values || {}), ...Object.fromEntries(entries) };
    Object.assign(process.env, Object.fromEntries(entries));
    return { saved: entries.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteEncryptedRuntimeSecrets(names) {
  const normalized = [...new Set((names || []).map(assertManagedName))];
  if (!normalized.length) return { deleted: 0 };
  const result = await getPostgresPool().query(
    "DELETE FROM integration_runtime_secrets WHERE name = ANY($1::text[])",
    [normalized]
  );
  if (runtimeCache.values) {
    for (const name of normalized) delete runtimeCache.values[name];
  }
  for (const name of normalized) delete process.env[name];
  return { deleted: result.rowCount };
}

export async function loadEncryptedRuntimeSecrets({ masterKey } = {}) {
  const key = masterKey || decodeSecretsMasterKey();
  const result = await getPostgresPool().query(
    `SELECT name, ciphertext, initialization_vector, authentication_tag, key_version
     FROM integration_runtime_secrets`
  );
  const values = {};
  for (const row of result.rows) {
    if (!managedNames.has(row.name)) continue;
    if (row.key_version !== 1) {
      throw new Error(`Unsupported encryption key version ${row.key_version} for ${row.name}`);
    }
    values[row.name] = decryptSecretValue(
      row.name,
      {
        ciphertext: row.ciphertext,
        initializationVector: row.initialization_vector,
        authenticationTag: row.authentication_tag,
      },
      key
    );
  }
  return values;
}

export async function hasEncryptedRuntimeSecrets() {
  const result = await getPostgresPool().query(
    "SELECT EXISTS (SELECT 1 FROM integration_runtime_secrets LIMIT 1) AS present"
  );
  return result.rows[0]?.present === true;
}

export async function hydrateRuntimeSecrets({ required = false, force = false } = {}) {
  if (!encryptedSecretStoreConfigured()) {
    if (required) {
      throw new Error(
        `Encrypted runtime secrets require PostgreSQL and ${ADMIN_SECRETS_MASTER_KEY}`
      );
    }
    return {};
  }
  if (!force && runtimeCache.values) {
    Object.assign(process.env, runtimeCache.values);
    return { ...runtimeCache.values };
  }
  if (!force && runtimeCache.loadPromise) return runtimeCache.loadPromise;
  runtimeCache.loadPromise = loadEncryptedRuntimeSecrets()
    .then((values) => {
      runtimeCache.values = values;
      Object.assign(process.env, values);
      return { ...values };
    })
    .finally(() => {
      runtimeCache.loadPromise = null;
    });
  return runtimeCache.loadPromise;
}

export function managedSecretsFromEnvironment(environment = process.env) {
  return Object.fromEntries(
    MANAGED_RUNTIME_SECRET_NAMES
      .map((name) => [name, String(environment[name] || "").trim()])
      .filter(([, value]) => value)
  );
}

export function resetRuntimeSecretCacheForTests() {
  runtimeCache.values = null;
  runtimeCache.loadPromise = null;
}
