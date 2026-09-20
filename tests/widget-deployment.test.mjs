import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfilePath = new URL("../Dockerfile", import.meta.url);
const composePath = new URL("../compose.yaml", import.meta.url);
const deployPath = new URL("../scripts/deploy.mjs", import.meta.url);
const dockerignorePath = new URL("../.dockerignore", import.meta.url);
const serverPath = new URL("../server.mjs", import.meta.url);

test("production image runs as a non-root user and uses the pg-ensuring custom server", async () => {
  const [dockerfile, server] = await Promise.all([
    readFile(dockerfilePath, "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.match(dockerfile, /USER nextjs/);
  assert.match(dockerfile, /CMD \["node", "server\.mjs"\]/);
  assert.match(dockerfile, /\/api\/health/);
  assert.match(dockerfile, /\/app\/genesys \.\/genesys/);
  assert.match(server, /await ensurePostgresSchema\(\)/);
  assert.match(server, /await seedWidgetExamples\(\{ refreshExisting: false \}\)/);
  assert.ok(server.indexOf("await ensurePostgresSchema()") < server.indexOf("server.listen"));
  assert.ok(
    server.indexOf("await ensurePostgresSchema()") <
      server.indexOf("await seedWidgetExamples({ refreshExisting: false })")
  );
  assert.ok(
    server.indexOf("await hydrateRuntimeSecrets") <
      server.indexOf("await seedWidgetExamples({ refreshExisting: false })")
  );
  assert.ok(
    server.indexOf("await seedWidgetExamples({ refreshExisting: false })") <
      server.indexOf("server.listen")
  );
});

test("Compose keeps bundled PostgreSQL private and optional", async () => {
  const compose = await readFile(composePath, "utf8");
  assert.match(compose, /profiles: \["bundled-db"\]/);
  assert.match(compose, /postgres:17-alpine/);
  assert.match(compose, /widget_postgres_data:\/var\/lib\/postgresql\/data/);
  assert.doesNotMatch(compose, /5432:5432/);
  assert.match(compose, /required: false/);
  assert.match(compose, /installer:/);
  assert.match(compose, /INSTALLER_ENV_READ_ONLY: "1"/);
  assert.match(compose, /node", "scripts\/manage-genesys-deploy\.mjs/);
  assert.match(compose, /genesys_audio_state:\/app\/\.genesys-audio/);
});

test("deploy script validates the encrypted-store bootstrap and remote database TLS before Docker mutations", async () => {
  const source = await readFile(deployPath, "utf8");
  const validation = source.indexOf("validateEnvironment(options, deployment.values)");
  const dockerVersion = source.indexOf('run("docker", ["version"]');
  assert.ok(validation >= 0 && validation < dockerVersion);
  assert.match(source, /ADMIN_SECRETS_MASTER_KEY/);
  assert.doesNotMatch(source, /env\.WIDGET_SESSION_SIGNING_SECRET/);
  assert.match(source, /Remote external PostgreSQL requires TLS/);
  assert.match(source, /--remove-volumes is allowed only together with --down/);
  assert.match(source, /generated\.POSTGRES_HOST = "postgres"/);
  assert.match(source, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(source, /--skip-genesys/);
  assert.match(source, /Continue\? \[y\/N\]/);
  assert.match(source, /--yes/);
  assert.ok(
    source.indexOf("await confirmDeployment(options)") <
      source.indexOf("bootstrapEnvironment(options.envFile, options)")
  );
});

test("Docker build context excludes local credentials and customer data", async () => {
  const source = await readFile(dockerignorePath, "utf8");
  assert.match(source, /^\.env$/m);
  assert.match(source, /^\.env\.\*$/m);
  assert.match(source, /^\*\.dump$/m);
  assert.match(source, /^\*\.key$/m);
});
