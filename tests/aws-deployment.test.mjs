import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("AWS Terraform provisions the requested single-node topology", () => {
  const main = read("deploy/aws/terraform/main.tf");
  const variables = read("deploy/aws/terraform/variables.tf");
  const versions = read("deploy/aws/terraform/versions.tf");

  assert.match(variables, /default\s*=\s*"genesys-integrations"/);
  assert.match(variables, /default\s*=\s*"t3\.medium"/);
  assert.match(variables, /default\s*=\s*"db\.t4g\.micro"/);
  assert.match(versions, /required_version\s*=\s*">= 1\.11\.0"/);
  assert.match(versions, /hashicorp\/random/);
  assert.match(main, /resource "aws_instance" "app"/);
  assert.match(main, /resource "aws_db_instance" "main"/);
  assert.match(main, /resource "random_id" "db_lifecycle"/);
  assert.match(main, /final_snapshot_identifier\s*=\s*var\.db_skip_final_snapshot \? null : "\$\{local\.name_prefix\}-pg-final-\$\{random_id\.db_lifecycle\.hex\}"/);
  assert.match(main, /ephemeral "random_password" "db"/);
  assert.match(main, /resource "aws_secretsmanager_secret_version" "db_bootstrap"/);
  assert.match(main, /ephemeral "aws_secretsmanager_secret_version" "db_bootstrap"/);
  assert.match(main, /password_wo\s*=\s*jsondecode\(ephemeral\.aws_secretsmanager_secret_version\.db_bootstrap\.secret_string\)\.password/);
  assert.doesNotMatch(main, /manage_master_user_password/);
  assert.match(main, /storage_encrypted\s*=\s*true/);
  assert.match(main, /publicly_accessible\s*=\s*false/);
  assert.match(main, /resource "aws_secretsmanager_secret" "db"/);
  assert.match(main, /secret_string_wo\s*=\s*jsonencode/);
  assert.match(main, /resource "aws_secretsmanager_secret" "app_env"/);
  assert.match(main, /db_secret_name\s*=\s*"\$\{var\.deployment_name\}\/db\/credentials"/);
  assert.match(main, /app_env_secret_name\s*=\s*"\$\{var\.deployment_name\}\/app\/env"/);
  assert.doesNotMatch(main, /rds!db-/);
  assert.match(main, /user_data\s*=\s*templatefile/);
  assert.doesNotMatch(main, /user_data\s*=\s*base64encode/);
});

test("AWS ingress terminates existing ACM TLS at an ALB and uses only port 3000", () => {
  const functionalFiles = [
    "deploy/aws/terraform/main.tf",
    "deploy/aws/terraform/variables.tf",
    "deploy/aws/terraform/user_data.sh.tpl",
    "deploy/aws/remote-deploy.sh",
    "deploy/aws/deploy.sh",
  ].map(read).join("\n");

  assert.match(functionalFiles, /certificate_arn\s*=\s*var\.acm_certificate_arn/);
  assert.match(functionalFiles, /resource "aws_lb" "main"/);
  assert.match(functionalFiles, /resource "aws_route53_record" "app"/);
  assert.match(functionalFiles, /app_port\s*=\s*3000/);
  assert.doesNotMatch(functionalFiles, /3001/);
  assert.match(functionalFiles, /\/api\/genesys\/audio-connector\/ws|HTTP and WebSocket upgrades/);
});

test("AWS EC2 uses standard SSM management and no SSH ingress", () => {
  const main = read("deploy/aws/terraform/main.tf");

  assert.match(main, /AmazonSSMManagedInstanceCore/);
  assert.doesNotMatch(main, /Fde[A-Z]|fde_extra/);
  assert.doesNotMatch(main, /from_port\s*=\s*22/);
  assert.match(main, /name\s*=\s*"\$\{local\.name_prefix\}-app-role"/);
  assert.match(main, /name\s*=\s*"\$\{local\.name_prefix\}-app-profile"/);
});

test("health check fails closed when PostgreSQL configuration is missing", () => {
  const health = read("app/api/health/route.js");

  assert.match(health, /serviceReady\s*=\s*widgetConfigured && database\.ready/);
  assert.doesNotMatch(health, /serviceReady\s*=\s*!widgetConfigured \|\| database\.ready/);
});

test("Portainer agent is opt-in and reachable only from explicit server CIDRs", () => {
  const main = read("deploy/aws/terraform/main.tf");
  const variables = read("deploy/aws/terraform/variables.tf");
  const userData = read("deploy/aws/terraform/user_data.sh.tpl");
  const deploy = read("deploy/aws/deploy.sh");

  assert.match(variables, /variable "portainer_agent_enabled"[\s\S]*?default\s*=\s*false/);
  assert.match(variables, /variable "portainer_agent_port"[\s\S]*?default\s*=\s*9001/);
  assert.match(variables, /variable "portainer_server_cidrs"[\s\S]*?default\s*=\s*\[\]/);
  assert.match(variables, /cidr != "0\.0\.0\.0\/0"/);
  assert.match(main, /var\.portainer_agent_enabled && length\(var\.portainer_server_cidrs\) > 0/);
  assert.match(main, /cidr_blocks\s*=\s*sort\(tolist\(var\.portainer_server_cidrs\)\)/);
  assert.match(userData, /portainer\/agent:lts/);
  assert.match(userData, /--restart=always/);
  assert.match(userData, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(userData, /"\$VOLUMES_DIR":\/var\/lib\/docker\/volumes/);
  assert.match(deploy, /PORTAINER_SERVER_CIDRS \(comma-separated CIDRs\)/);
  const remote = read("deploy/aws/remote-deploy.sh");
  assert.match(remote, /reconcile_portainer_agent/);
  assert.match(remote, /docker rm -f portainer_agent/);
  assert.match(remote, /PORTAINER_AGENT_PORT:9001/);
});

test("remote deploy preserves app state and rolls back a failed image", () => {
  const remote = read("deploy/aws/remote-deploy.sh");
  const userData = read("deploy/aws/terraform/user_data.sh.tpl");

  for (const mount of [
    "/app/.genesys-audio",
    "/app/.genesys-widget",
    "/app/.genesys-admin",
    "/app/.genesys-shared",
    "/app/.widget-assets",
  ]) {
    assert.match(remote, new RegExp(mount.replaceAll(".", "\\.")));
  }
  assert.match(remote, /PGSSLROOTCERT|rds-ca\.pem/);
  assert.match(remote, /DB_SECRET:\?DB_SECRET is required/);
  assert.match(remote, /refresh-env\.sh.*APP_ENV_SECRET.*DB_SECRET/);
  assert.match(remote, /install_runtime_helpers/);
  assert.match(remote, /install_runtime_prerequisites/);
  assert.match(remote, /apt-get install -y ca-certificates curl gnupg unzip jq zstd python3/);
  assert.match(remote, /apt-get install -y docker-ce docker-ce-cli containerd\.io docker-compose-plugin/);
  assert.match(remote, /awscli-exe-linux-x86_64\.zip/);
  assert.match(remote, /systemctl enable --now docker/);
  assert.match(remote, /cat > \/opt\/gix\/refresh-env\.sh/);
  assert.match(userData, /Database secret is missing required fields/);
  assert.match(userData, /lines\.append\(f"DATABASE_URL=\{database_url\}"\)/);
  assert.match(remote, /Rolling back to previous image/);
  assert.match(remote, /sha256sum -c image\.tar\.zst\.sha256/);
  assert.match(remote, /curl -fsS --max-time 5.*\/api\/health/);
  assert.match(remote, /cleanup_deployment_storage/);
  assert.match(remote, /docker container prune -f/);
  assert.match(remote, /docker image prune -af/);
  assert.match(remote, /find "\$APP_DIR\/releases"[\s\S]*-name 'image\.tar\.zst'/);
  assert.match(remote, /assert_artifact_space/);
  assert.match(remote, /aws s3api head-object/);
  assert.match(remote, /trap cleanup_partial_artifact EXIT/);
  assert.match(remote, /zstd -dc image\.tar\.zst \| docker load\nrm -f image\.tar\.zst/);
});

test("AWS runtime env combines separate secrets without persisting a stale database URL", () => {
  const userData = read("deploy/aws/terraform/user_data.sh.tpl");
  const refresh = userData.match(
    /cat > \/opt\/gix\/refresh-env\.sh <<'ENV_REFRESH'\n([\s\S]*?)\nENV_REFRESH/,
  )?.[1];
  assert.ok(refresh, "expected embedded refresh-env.sh");

  const shellCheck = spawnSync("bash", ["-n"], { input: refresh, encoding: "utf8" });
  assert.equal(shellCheck.status, 0, shellCheck.stderr);

  const python = refresh.match(/python3 - "\$TARGET" <<'PY'\n([\s\S]*?)\nPY/)?.[1];
  assert.ok(python, "expected embedded database URL composer");

  const workdir = mkdtempSync(join(tmpdir(), "gix-env-test-"));
  const target = join(workdir, "app.env");
  try {
    const result = spawnSync("python3", ["-", target], {
      input: python,
      encoding: "utf8",
      env: {
        ...process.env,
        APP_ENV_CONTENT: "NODE_ENV=production\nDATABASE_URL=stale\nPORT=3000\n",
        DB_SECRET_JSON: JSON.stringify({
          username: "user@example.com",
          password: "p/@ word",
          host: "db.internal",
          port: 5432,
          dbname: "telnyx_genesys",
        }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const env = readFileSync(target, "utf8");
    assert.doesNotMatch(env, /DATABASE_URL=stale/);
    assert.match(
      env,
      /DATABASE_URL=postgresql:\/\/user%40example\.com:p%2F%40%20word@db\.internal:5432\/telnyx_genesys/,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("deploy script separates infra, update and interactive bootstrap lifecycles", () => {
  const deploy = read("deploy/aws/deploy.sh");

  assert.match(deploy, /plan\)/);
  assert.match(deploy, /up\)/);
  assert.match(deploy, /update\)/);
  assert.match(deploy, /bootstrap\)/);
  assert.match(deploy, /status\)/);
  assert.match(deploy, /destroy\)/);
  assert.match(deploy, /AWS-StartInteractiveCommand/);
  assert.match(deploy, /secretsmanager put-secret-value/);
  assert.match(deploy, /DEPLOYMENT_NAME=\$\{DEPLOYMENT_NAME:-genesys-integrations\}/);
  assert.match(deploy, /DB_SECRET='\$db_secret_arn'/);
  assert.doesNotMatch(deploy, /echo "DATABASE_URL=/);
  assert.match(deploy, /docker build --platform linux\/amd64/);
  assert.match(deploy, /ssm send-command/);
  assert.match(deploy, /cloud-init status --wait >\/dev\/null 2>&1 \|\| true;/);
  assert.match(deploy, /release_id=\$\{prefix##\*\/\}/);
  assert.match(deploy, /--comment "Deploy Genesys Integrations \$release_id"/);
  assert.doesNotMatch(deploy, /--comment "Deploy Genesys Integrations \$prefix"/);
});

test("GitHub workflow emits immutable S3 artifacts", () => {
  const workflow = read(".github/workflows/build-s3-image-artifact.yml");

  assert.match(workflow, /workflow_dispatch:/);
  // Pinned on purpose: this workflow is dispatch-only, so CI never exercises it
  // and a silent action bump would only surface during a release build. v5
  // changed invalid-boolean input handling and v6 moved the action to node24;
  // neither affects this usage, which passes only role-to-assume and
  // aws-region over OIDC. Re-audit before raising the pin again.
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v6/);
  assert.match(workflow, /image\.tar\.zst/);
  assert.match(workflow, /image\.tar\.zst\.sha256/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /AWS_ROLE_TO_ASSUME/);
});

test("the artifact workflow is dispatchable with only the inputs fde-infra supplies", () => {
  // fde-infra-cli's triggerBuild() sends exactly these four inputs and nothing
  // else. Every other workflow_dispatch input must therefore carry a default:
  // a required input without one makes `gh workflow run` fail, and the CLI has
  // no way to know it needs to send more. Adding such an input here silently
  // breaks every build started from the CLI.
  const supplied = new Set(["ref", "artifact_bucket", "artifact_prefix", "aws_region"]);
  const workflow = read(".github/workflows/build-s3-image-artifact.yml");
  const block = workflow.slice(workflow.indexOf("inputs:"), workflow.indexOf("permissions:"));
  const inputs = [...block.matchAll(/^ {6}([a-z_]+):\n((?: {8}.*\n)*)/gm)];

  assert.ok(inputs.length >= supplied.size, "workflow_dispatch inputs could not be parsed");
  for (const [, name, body] of inputs) {
    assert.ok(supplied.has(name) || /^ {8}default:/m.test(body), `${name} must have a default or be sent by fde-infra`);
  }
  for (const name of supplied) {
    assert.ok(inputs.some(([, parsed]) => parsed === name), `${name} must remain a workflow input`);
  }
});
