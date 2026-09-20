import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, statSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createBuildInfo, dockerBuildMetadata } from "../../scripts/lib/build-info.mjs";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function run(command, args, { capture = false, input, cwd, env = process.env, quiet = false } = {}) {
  if (!quiet) console.log(`[deploy] ${command} ${args.map(shellQuote).join(" ")}`);
  const result = spawnSync(command, args, {
    cwd, env, input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Secret-bearing commands deliberately do not echo stdout or stderr.
    if (!quiet && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed (${result.status ?? result.signal})`);
  }
  return result.stdout?.trim() || "";
}

export function validateConfig(target, config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Configuration must be a JSON object");
  const common = ["deployment_name", "domain", "region", "instance_type"];
  const fields = {
    aws: ["fde_enabled", "fde_github_owner", "fde_github_repo", "fde_github_workflow", "route53_zone_id", "route53_zone_name", "acm_certificate_arn", "artifact_bucket", "artifact_prefix", "owner_email", "db_instance_class", "root_volume_size", "db_allocated_storage", "db_backup_retention_days", "db_skip_final_snapshot", "vpc_cidr", "public_subnet_cidrs", "private_subnet_cidrs", "alb_deletion_protection", "portainer_agent_enabled", "portainer_agent_port", "portainer_server_cidrs", "tags"],
    azure: ["dns_zone_name", "dns_zone_resource_group", "subscription_id", "ssh_public_key", "admin_cidr", "db_instance_type", "disk_size_gb"],
    gcp: ["project_id", "zone", "db_instance_type", "disk_size_gb", "db_deletion_protection"],
  };
  if (!fields[target]) throw new Error(`Unsupported target: ${target}`);
  for (const key of Object.keys(config)) {
    if (![...common, ...fields[target]].includes(key)) throw new Error(`Unknown ${target} configuration field: ${key}`);
  }
  if (!/^[a-z][a-z0-9-]{1,25}$/.test(config.deployment_name || "")) throw new Error("deployment_name must be a 2-26 character lowercase slug starting with a letter");
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(config.domain || "")) throw new Error("domain must be a public hostname without scheme, port or path");
  if (!/^[a-z][a-z0-9-]+$/.test(config.region || "")) throw new Error("region is required");
  if (target === "azure") {
    if (Boolean(config.dns_zone_name) !== Boolean(config.dns_zone_resource_group)) throw new Error("Supply both dns_zone_name and dns_zone_resource_group");
    if (config.dns_zone_name && config.domain !== config.dns_zone_name && !config.domain.endsWith(`.${config.dns_zone_name}`)) throw new Error("domain must belong to dns_zone_name");
    if (!/^[0-9a-f-]{36}$/i.test(config.subscription_id || "")) throw new Error("subscription_id must be a UUID");
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: .*)?$/.test(config.ssh_public_key || "")) throw new Error("ssh_public_key must contain an SSH public key");
    const parts = String(config.admin_cidr || "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
    if (!parts || parts.slice(1, 5).some(part => Number(part) > 255) || Number(parts[5]) < 24 || Number(parts[5]) > 32) throw new Error("admin_cidr must restrict SSH to IPv4 /24 through /32");
  }
  if (target === "gcp") {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project_id || "")) throw new Error("project_id is required");
    if (!new RegExp(`^${config.region}-[a-z]$`).test(config.zone || "")) throw new Error("zone must belong to region");
  }
  if (target === "aws") {
    if (config.fde_enabled !== undefined && typeof config.fde_enabled !== "boolean") throw new Error("fde_enabled must be a boolean");
    for (const name of ["fde_github_owner", "fde_github_repo", "fde_github_workflow"]) {
      if (config[name] !== undefined && (typeof config[name] !== "string" || !config[name].trim())) throw new Error(`${name} must be a nonempty string`);
    }
    if (!config.route53_zone_id && !config.route53_zone_name) throw new Error("route53_zone_id or route53_zone_name is required");
    if (!config.acm_certificate_arn && !config.route53_zone_name) throw new Error("acm_certificate_arn or route53_zone_name is required");
    if (!config.owner_email) throw new Error("owner_email is required");
  }
  return config;
}

export function azureCommandOutput(result, marker) {
  const value = typeof result === "string" ? JSON.parse(result) : result;
  const messages = (value.value || []).map(entry => entry.message || "").join("\n");
  // Azure's outer HTTP/CLI success does not establish the shell's exit status.
  if (!messages.split(/\r?\n/).includes(marker)) throw new Error("Azure VM command did not report successful completion; inspect Run Command output on the VM");
  return messages;
}

export function releaseFiles(deployment, image) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]+$/.test(image)) throw new Error("Invalid image reference");
  if (!/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(deployment.domain)) throw new Error("Invalid deployment domain");
  const sql = deployment.sql_connection || "";
  if (sql && !/^[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/.test(sql)) throw new Error("Invalid Cloud SQL connection name");
  return {
    "deployment.json": JSON.stringify(deployment, null, 2) + "\n",
    "compose.env": `APP_IMAGE=${image}\nSQL_CONNECTION=${sql}\n`,
    "Caddyfile": `${deployment.domain} {\n  reverse_proxy app:3000 {\n    flush_interval -1\n  }\n}\n`,
  };
}

export function remoteCommand(deployment, release, checksum, providerSource, archiveBytes = 0) {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 0) throw new Error("Invalid archive size");
  if (!/^[a-zA-Z0-9-]+$/.test(release) || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid artifact identity");
  const config = Buffer.from(JSON.stringify(deployment)).toString("base64");
  const provider = Buffer.from(providerSource).toString("base64");
  return `set -eu
umask 077
install -d -m 0700 /opt/genesys-integrations
cd /opt/genesys-integrations
# Separate staging directories make a second upload harmless until the lock is held.
exec 8>artifact.lock
flock -n 8 || exit 1
for attempt in $(seq 1 120); do
  if docker compose version >/dev/null 2>&1; then break; fi
  sleep 5
done
docker compose version >/dev/null
available=$(df -PB1 . | awk 'NR==2 {print $4}')
required=$(( ${archiveBytes} * 16 + 1073741824 ))
[ "$available" -ge "$required" ] || { echo 'Insufficient disk space; preserve rollback images and expand or clean the disk' >&2; exit 1; }
mkdir -p releases/${release}
cd releases/${release}
printf '%s' '${provider}' | base64 -d > provider.py
printf '%s' '${config}' | base64 -d > deployment.json
python3 provider.py download deployment.json '${release}/release.tar' release.tar
printf '%s  release.tar\\n' '${checksum}' | sha256sum -c -
tar -xf release.tar
rm release.tar
bash remote-deploy.sh`;
}

async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function terraformEnvironment(config) {
  return { ...process.env, ...Object.fromEntries(Object.entries(config).map(([key, value]) => [
    `TF_VAR_${key}`, typeof value === "string" ? value : JSON.stringify(value),
  ])) };
}

export async function cloudDeploy({ root, target, command, config, yes, dryRun, sshKey, confirm }) {
  const tfDir = join(root, "deploy", target, "terraform");
  const env = terraformEnvironment(config || {});
  let hadDeployment = false;
  const tf = (args, capture = false) => run("terraform", [`-chdir=${tfDir}`, ...args], { env, capture });
  if (dryRun) {
    console.log(`[deploy] Target: ${target}; action: ${command}; Terraform root: ${tfDir}`);
    if (["plan", "up", "destroy"].includes(command)) {
      console.log("terraform init -input=false");
      console.log(`terraform plan ${command === "destroy" ? "-destroy " : ""}-input=false -out=gix.tfplan`);
      if (command !== "plan") console.log("terraform apply -input=false gix.tfplan (after confirmation)");
    }
    if (["up", "update"].includes(command)) console.log(`Build linux/amd64 image; upload checksummed release to ${target === "azure" ? "Blob Storage" : "GCS"}; deploy via ${target === "azure" ? "VM Run Command" : "IAP SSH"}; verify health`);
    if (["status", "bootstrap"].includes(command)) console.log(`Read Terraform outputs; run ${command} against that deployment`);
    return;
  }
  run("terraform", ["version"], { capture: true });
  if (target === "azure") run("az", ["account", "show", ...(config?.subscription_id ? ["--subscription", config.subscription_id] : []), "-o", "json"], { capture: true });
  else run("gcloud", ["auth", "print-access-token"], { capture: true, quiet: true });
  if (["up", "update"].includes(command)) {
    run("docker", ["version"], { capture: true });
    run("zstd", ["--version"], { capture: true });
  }
  if (["up", "plan", "destroy"].includes(command)) {
    tf(["init", "-input=false"]);
    if (command === "up") hadDeployment = Boolean(JSON.parse(tf(["output", "-json"], true)).deployment);
    tf(["plan", ...(command === "destroy" ? ["-destroy"] : []), "-input=false", "-out=gix.tfplan"]);
    if (command === "plan") return;
    await confirm(`${command === "destroy" ? "Destroy infrastructure, including the database and VM data" : "Apply this plan and deploy the application"} for ${config.deployment_name}?`, yes);
    tf(["apply", "-input=false", "gix.tfplan"]);
    if (command === "destroy") return;
  }
  const deployment = JSON.parse(tf(["output", "-json", "deployment"], true));
  if (deployment.target !== target) throw new Error("Terraform outputs belong to a different target");
  const az = (args, options = {}) => run("az", [...args, "--subscription", deployment.subscription_id], options);
  const gc = (args, options = {}) => run("gcloud", ["--project", deployment.project_id, ...args], options);
  if (command === "status") {
    console.log(JSON.stringify(deployment, null, 2));
    if (target === "azure") az(["vm", "get-instance-view", "--resource-group", deployment.resource_group, "--name", deployment.instance, "-o", "table"]);
    else gc(["compute", "instances", "describe", deployment.instance, "--zone", deployment.zone, "--format=json(status)"]);
    const response = await fetch(`${deployment.app_url}/api/health`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Public health returned ${response.status}`);
    console.log("Public HTTPS health: OK");
    return;
  }
  if (command === "bootstrap") {
    const installer = "sudo bash /opt/genesys-integrations/current/run-installer.sh";
    if (target === "azure") run("ssh", [...(sshKey ? ["-i", resolve(sshKey)] : []), "-t", `gixadmin@${deployment.public_ip}`, installer]);
    else gc(["compute", "ssh", deployment.instance, "--zone", deployment.zone, "--tunnel-through-iap", "--command", installer, "--", "-t"]);
    return;
  }
  if (command === "update") await confirm(`Build and deploy the current working tree to ${deployment.app_url}?`, yes);
  const work = mkdtempSync(join(tmpdir(), "genesys-release-"));
  try {
    // Read failures must never generate a new encryption key for an existing DB.
    let runtime;
    if (target === "azure") {
      const names = JSON.parse(az(["keyvault", "secret", "list", "--vault-name", deployment.vault, "--query", "[].name", "-o", "json"], { capture: true, quiet: true }));
      if (names.includes(deployment.app_secret)) runtime = JSON.parse(az(["keyvault", "secret", "show", "--vault-name", deployment.vault, "--name", deployment.app_secret, "-o", "json"], { capture: true, quiet: true })).value;
    } else {
      const versions = JSON.parse(gc(["secrets", "versions", "list", deployment.app_secret, "--format=json"], { capture: true, quiet: true }));
      if (versions.length) runtime = gc(["secrets", "versions", "access", "latest", "--secret", deployment.app_secret], { capture: true, quiet: true });
    }
    if (runtime === undefined) {
      if (command === "update" || hadDeployment) throw new Error("Runtime secret is missing on existing infrastructure; restore the encryption key from backup before retrying");
      runtime = `ADMIN_SECRETS_MASTER_KEY=${randomBytes(32).toString("base64")}\n`;
      const runtimePath = join(work, "bootstrap.env");
      writeFileSync(runtimePath, runtime, { mode: 0o600 });
      if (target === "azure") az(["keyvault", "secret", "set", "--vault-name", deployment.vault, "--name", deployment.app_secret, "--file", runtimePath, "-o", "none"], { capture: true, quiet: true });
      else gc(["secrets", "versions", "add", deployment.app_secret, "--data-file", runtimePath], { capture: true, quiet: true });
    }
    const key = runtime.match(/^ADMIN_SECRETS_MASTER_KEY=(.+)$/m)?.[1];
    if (!key || Buffer.from(key.trim(), "base64").length !== 32) throw new Error("Runtime secret has no valid encryption key; repair it from backup");
    const release = `${Date.now()}-${randomBytes(5).toString("hex")}`;
    const image = `telnyx-genesys-integrations:${release}`;
    // Same reason as the AWS path and Compose: .git is outside the build
    // context, so the identity has to be captured here and handed in, or the
    // Azure and GCP production images always claim to be development builds.
    const build = createBuildInfo({ root });
    const docker = dockerBuildMetadata(build);
    run("docker", ["build", "--platform", "linux/amd64",
      "--build-arg", `GI_BUILD_INFO=${docker.args.GI_BUILD_INFO}`,
      ...Object.entries(docker.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
      "--tag", image, root]);
    run("docker", ["save", "--output", join(work, "image.tar"), image]);
    run("zstd", ["-T0", "-3", "--rm", join(work, "image.tar"), "-o", join(work, "image.tar.zst")]);
    const assets = ["provider.py", "remote-deploy.sh", "run-installer.sh", "compose.yaml"];
    for (const file of assets) copyFileSync(join(root, "deploy", "runtime", file), join(work, file));
    const generated = releaseFiles(deployment, image);
    for (const [file, value] of Object.entries(generated)) writeFileSync(join(work, file), value, { mode: 0o600 });
    // Explicit allowlist keeps bootstrap.env and all operator credentials out of artifacts.
    run("tar", ["-cf", join(work, "release.tar"), "-C", work, "image.tar.zst", ...assets, ...Object.keys(generated)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const checksum = await fileHash(join(work, "release.tar"));
    const object = `${release}/release.tar`;
    if (target === "azure") az(["storage", "blob", "upload", "--auth-mode", "login", "--account-name", deployment.storage_account, "--container-name", deployment.container, "--name", object, "--file", join(work, "release.tar"), "--overwrite", "false", "-o", "none"]);
    else gc(["storage", "cp", "--no-clobber", join(work, "release.tar"), `gs://${deployment.bucket}/${object}`]);
    const script = remoteCommand(deployment, release, checksum, readFileSync(join(root, "deploy", "runtime", "provider.py"), "utf8"), statSync(join(work, "release.tar")).size);
    if (target === "azure") {
      const scriptFile = join(work, "invoke.sh");
      // The Azure shell may be /bin/sh. Launch Bash explicitly for fd locking.
      writeFileSync(scriptFile, `#!/bin/sh\nexec bash <<'GIX_SCRIPT'\n${script}\nGIX_SCRIPT\n`, { mode: 0o600 });
      const result = az(["vm", "run-command", "invoke", "--resource-group", deployment.resource_group, "--name", deployment.instance, "--command-id", "RunShellScript", "--scripts", `@${scriptFile}`, "-o", "json"], { capture: true });
      console.log(azureCommandOutput(result, "GIX_DEPLOY_OK"));
    } else {
      gc(["compute", "ssh", deployment.instance, "--zone", deployment.zone, "--tunnel-through-iap", "--command", `sudo bash -c ${shellQuote(script)}`], { quiet: true });
    }
    console.log(`[deploy] Application healthy on VM. Point the DNS A record ${deployment.domain} to ${deployment.public_ip}. HTTPS certificates are obtained automatically after DNS resolves.`);
    console.log(`[deploy] Verify public HTTPS with: ./deploy/deploy status --target ${target}`);
    console.log(`[deploy] Then configure Genesys/Telnyx: ./deploy/deploy bootstrap --target ${target}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
