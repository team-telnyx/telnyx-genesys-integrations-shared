import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function isIgnored(file) {
  try {
    await execFileAsync("git", ["check-ignore", "--no-index", "--quiet", file], {
      cwd: new URL("..", import.meta.url),
    });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("gitignore protects local credentials, state, and customer data", async () => {
  const protectedPaths = [
    ".env",
    ".env.genesys-tts",
    ".env.genesys-audio",
    "production.env",
    "private.key",
    "credentials.p12",
    ".npmrc",
    "app.sqlite",
    "backups/database.dump",
    "exports/contacts.csv",
    "recordings/call.wav",
    "transcripts/call.txt",
    ".genesys-tts/plans/example.json",
    ".genesys-audio/runs/example.json",
  ];

  for (const file of protectedPaths) {
    assert.equal(await isIgnored(file), true, `${file} must be ignored`);
  }

  assert.equal(await isIgnored(".env.example"), false, ".env.example must remain public");
  assert.equal(
    await isIgnored("credentials.example.json"),
    false,
    "credential templates must remain publishable"
  );
});

test("public environment template contains no account-bound values", async () => {
  const environment = await source(".env.example");
  for (const name of [
    "TELNYX_API_KEY",
    "TELNYX_PUBLIC_KEY",
    "GC_CLIENT_SECRET",
    "GC_CLIENT_CRED_CLIENT_SECRET",
    "GC_SECRET_TOKEN",
    "GC_AUDIO_CONNECTOR_API_KEY",
    "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
    "GC_AUDIO_HANDOFF_API_KEY",
    "GC_PUBLIC_BASE_URL",
  ]) {
    assert.doesNotMatch(
      environment,
      new RegExp(`^${name}=`, "m"),
      `${name} must be stored in encrypted PostgreSQL, not in .env`
    );
  }
  assert.match(environment, /^ADMIN_SECRETS_MASTER_KEY=$/m);
  assert.doesNotMatch(environment, /assistant-[0-9a-f]{8}-[0-9a-f-]{27}/i);
  assert.doesNotMatch(environment, /\+48\d{9}/);
});
