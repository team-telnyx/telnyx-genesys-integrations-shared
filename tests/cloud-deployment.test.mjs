import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseArguments } from "../deploy/cli.mjs";
import { azureCommandOutput, validateConfig, releaseFiles, remoteCommand, shellQuote, cloudDeploy } from "../deploy/lib/cloud.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const config = { deployment_name: "genesys-test", domain: "genesys.example.com", region: "europe-west1", zone: "europe-west1-b", project_id: "test-project" };
const azure = { deployment_name: "genesys-test", domain: "genesys.example.com", region: "westeurope", subscription_id: "00000000-0000-0000-0000-000000000000", admin_cidr: "203.0.113.10/32", ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhWVf4ksI91EgjsTDEMVIOGbZiqVCDlcGGntVPpyYqg" };
const temporary = (t) => { const dir = mkdtempSync(join(tmpdir(), "gix-test-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test("CLI routes cloud targets while retaining explicit local options", () => {
  assert.equal(parseArguments(["up", "--target", "google"]).target, "gcp");
  assert.deepEqual(parseArguments(["--mode", "external", "--env-file", "custom.env"]).localArgs, ["--mode", "external", "--env-file", "custom.env"]);
  assert.throws(() => parseArguments(["--target"]), /requires a value/);
  assert.throws(() => parseArguments(["--target", "unknown"]), /must be/);
});

test("cloud config rejects credentials, public SSH and invalid domains before provisioning", () => {
  assert.deepEqual(validateConfig("gcp", config), config);
  assert.deepEqual(validateConfig("azure", azure), azure);
  assert.throws(() => validateConfig("azure", { ...azure, dns_zone_name: "example.com" }), /both/);
  assert.throws(() => validateConfig("azure", { ...azure, dns_zone_name: "other.com", dns_zone_resource_group: "dns" }), /belong/);
  assert.throws(() => validateConfig("gcp", { ...config, service_account_key: "private" }), /Unknown/);
  assert.throws(() => validateConfig("gcp", { ...config, domain: "https://host.example.com/path" }), /hostname/);
  assert.throws(() => validateConfig("gcp", { ...config, zone: "us-east1-b" }), /belong/);
  assert.throws(() => validateConfig("azure", { ...azure, admin_cidr: "0.0.0.0/0" }), /restrict/);
  assert.throws(() => validateConfig("azure", { ...azure, ssh_public_key: "-----BEGIN PRIVATE KEY-----" }), /public key/);
});

test("dry runs neither create env files nor execute cloud/Docker commands", async (t) => {
  const dir = temporary(t);
  const envFile = join(dir, "new.env");
  const local = spawnSync(process.execPath, ["--", join(root, "deploy/cli.mjs"), "plan", "--target", "local", "--env-file", envFile], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /docker compose/);
  assert.equal(existsSync(envFile), false);
  for (const target of ["aws", "azure", "gcp"]) {
    const source = target === "azure" ? azure : target === "gcp" ? config : { deployment_name: "genesys-test", domain: "genesys.example.com", region: "us-east-2", owner_email: "operator@example.com", route53_zone_id: "ZEXAMPLE", acm_certificate_arn: "example" };
    const file = join(dir, `${target}.json`);
    writeFileSync(file, JSON.stringify(source));
    const before = readFileSync(file, "utf8");
    const result = spawnSync(process.execPath, ["--", join(root, "deploy/cli.mjs"), "up", "--target", target, "--config", file, "--dry-run"], { encoding: "utf8", env: { PATH: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), before);
  }
  assert.deepEqual(readdirSync(dir).sort(), ["aws.json", "azure.json", "gcp.json"]);
});

test("Azure shell errors cannot masquerade as successful CLI results", () => {
  assert.throws(() => azureCommandOutput({ value: [{ code: "ProvisioningState/succeeded", message: "[stdout]\n[stderr]\ndocker failed" }] }, "GIX_DEPLOY_OK"), /did not report/);
  assert.match(azureCommandOutput({ value: [{ message: "[stdout]\nGIX_DEPLOY_OK\n[stderr]\n" }] }, "GIX_DEPLOY_OK"), /GIX_DEPLOY_OK/);
  assert.throws(() => azureCommandOutput({ value: [{ message: "echo GIX_DEPLOY_OK" }] }, "GIX_DEPLOY_OK"));
});

test("release packaging keeps provider identifiers inert and configures streamed HTTPS", () => {
  const deployment = { target: "gcp", ...config, sql_connection: "test-project:europe-west1:genesys-db" };
  const files = releaseFiles(deployment, "genesys:release-123");
  assert.match(files.Caddyfile, /reverse_proxy app:3000/);
  assert.match(files.Caddyfile, /flush_interval -1/);
  assert.doesNotMatch(Object.values(files).join("\n"), /ADMIN_SECRETS_MASTER_KEY|DATABASE_URL/);
  assert.throws(() => releaseFiles({ ...deployment, domain: "x; touch /tmp/evil" }, "genesys:123"));
  assert.throws(() => releaseFiles(deployment, "genesys:123\nEVIL=value"));
  const script = remoteCommand({ ...deployment, vault: "$(exit 42)'" }, "release-123", "a".repeat(64), "# Python helper");
  assert.doesNotMatch(script, /\$\(exit 42\)/);
  assert.match(script, /sha256sum -c -[\s\S]*tar -xf/);
  assert.equal(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status, 0);
  const quoted = spawnSync("bash", ["-c", `printf '%s' ${shellQuote("a'$(exit 42)\nb")}`], { encoding: "utf8" });
  assert.equal(quoted.stdout, "a'$(exit 42)\nb");
});

test("runtime env preserves encryption key and encodes credentials without evaluation", (t) => {
  const dir = temporary(t);
  const file = join(dir, "env-test.py");
  writeFileSync(file, `import importlib.util, json, sys\nspec=importlib.util.spec_from_file_location('provider', sys.argv[1])\nprovider=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(provider)\ndata=json.load(sys.stdin)\nprint(provider.environment(**data),end='')\n`);
  const key = Buffer.alloc(32, 7).toString("base64");
  const input = { config: { target: "azure", domain: "genesys.example.com" }, runtime: `ADMIN_SECRETS_MASTER_KEY=${key}\nEXTRA=$literal\nDATABASE_URL=stale\nPOSTGRES_SSL=false\n`, database: { username: "user@example.com", password: "p/@ $word", host: "db.postgres.database.azure.com", port: 5432, dbname: "genesys" } };
  const invoke = value => spawnSync("python3", [file, join(root, "deploy/runtime/provider.py")], { input: JSON.stringify(value), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const result = invoke(input);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /p%2F%40%20%24word/);
  assert.match(result.stdout, /EXTRA=\$literal/);
  assert.match(result.stdout, /PGSSLMODE=verify-full/);
  assert.ok(result.stdout.includes(`ADMIN_SECRETS_MASTER_KEY=${key}`));
  assert.doesNotMatch(result.stdout, /DATABASE_URL=stale|POSTGRES_SSL=false/);
  assert.notEqual(invoke({ ...input, runtime: "ADMIN_SECRETS_MASTER_KEY=bad" }).status, 0);
  assert.match(invoke({ ...input, config: { ...input.config, target: "gcp" } }).stdout, /PGSSLMODE=disable/);
});

test("cloud secret read failure aborts update without creating a key or uploading an image", async (t) => {
  const dir = temporary(t);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const log = join(dir, "calls.jsonl");
  const deployment = { target: "azure", ...azure, resource_group: "test-rg", instance: "test-app", vault: "test-vault", app_secret: "app-env", app_url: "https://genesys.example.com" };
  for (const name of ["terraform", "az", "docker", "zstd"]) {
    const script = `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({name:${JSON.stringify(name)},args})+'\\n');\nif (${JSON.stringify(name)}==='terraform' && args.includes('output')) console.log(${JSON.stringify(JSON.stringify(deployment))});\nif (${JSON.stringify(name)}==='az' && args.includes('secret')) process.exit(1);\n`;
    writeFileSync(join(bin, name), script, { mode: 0o755 });
  }
  const prior = process.env.PATH;
  process.env.PATH = bin;
  try {
    await assert.rejects(cloudDeploy({ root: dir, target: "azure", command: "update", config: azure, yes: true, confirm: async () => {} }), /az failed/);
  } finally { process.env.PATH = prior; }
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.some(call => call.args.includes("build") || call.args.includes("set") || call.args.includes("upload")), false);
});

test("remote update restores previous release when a new container cannot start", (t) => {
  const dir = temporary(t);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const old = join(dir, "old"); mkdirSync(old);
  const next = join(dir, "next"); mkdirSync(next);
  const log = join(dir, "docker.log");
  symlinkSync(old, join(dir, "current"));
  let script = readFileSync(join(root, "deploy/runtime/remote-deploy.sh"), "utf8").replace("APP_DIR=/opt/genesys-integrations", `APP_DIR=${shellQuote(dir)}`);
  writeFileSync(join(next, "remote-deploy.sh"), script);
  writeFileSync(join(next, "provider.py"), "# Stub: no cloud calls\n");
  writeFileSync(join(next, "deployment.json"), '{"target":"azure"}');
  writeFileSync(join(next, "image.tar.zst"), "fixture");
  writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "zstd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\ncase "$*" in *next/compose.yaml*up*) exit 1;; esac\ncat >/dev/null\n`, { mode: 0o755 });
  const result = spawnSync("bash", [join(next, "remote-deploy.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Restoring previous application image/);
  assert.ok(readFileSync(log, "utf8").includes(`${old}/compose.yaml up -d app proxy`));
  assert.doesNotMatch(result.stdout, /GIX_DEPLOY_OK/);
});
