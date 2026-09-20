#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
TF_DIR="$SCRIPT_DIR/terraform"
REMOTE_DEPLOY_SCRIPT="$SCRIPT_DIR/remote-deploy.sh"
PLAN_FILE=gix.tfplan

AWS_REGION=${AWS_REGION:-us-east-2}
AWS_PROFILE=${AWS_PROFILE:-}
DEPLOYMENT_NAME=${DEPLOYMENT_NAME:-genesys-integrations}
DOMAIN=${DOMAIN:-}
ROUTE53_ZONE_NAME=${ROUTE53_ZONE_NAME:-}
ROUTE53_ZONE_ID=${ROUTE53_ZONE_ID:-}
ACM_CERTIFICATE_ARN=${ACM_CERTIFICATE_ARN:-}
ARTIFACT_BUCKET=${ARTIFACT_BUCKET:-}
ARTIFACT_PREFIX=${ARTIFACT_PREFIX:-genesys-integrations}
OWNER_EMAIL=${OWNER_EMAIL:-$(git config user.email 2>/dev/null || true)}
INSTANCE_TYPE=${INSTANCE_TYPE:-t3.medium}
DB_INSTANCE_CLASS=${DB_INSTANCE_CLASS:-db.t4g.micro}
PORTAINER_AGENT_ENABLED=${PORTAINER_AGENT_ENABLED:-}
PORTAINER_AGENT_PORT=${PORTAINER_AGENT_PORT:-}
PORTAINER_SERVER_CIDRS=${PORTAINER_SERVER_CIDRS:-}
FDE_ENABLED=${TF_VAR_fde_enabled:-false}
FDE_FLAG=false
YES=false
TEMP_DIR=""
ARTIFACT_S3_PREFIX=""

usage() {
  cat <<'EOF'
Usage: ./deploy/aws/deploy.sh <command> [--yes] [--fde]

Commands:
  plan       Initialize Terraform and show the infrastructure plan (read-only in AWS)
  up         Create/update infrastructure, configure the runtime secret, build and deploy the app
  update     Build and deploy the current working tree without changing infrastructure
  bootstrap  Open an interactive SSM installer for the first Genesys/Telnyx setup
  status     Show Terraform outputs, EC2 state, target health and public health
  destroy    Plan and destroy Terraform-managed infrastructure (confirmation required)

Options:
  --fde, -fde  Enable AWS discovery and management tags for FDE CLI (default: off)

Environment overrides:
  AWS_PROFILE, AWS_REGION, DEPLOYMENT_NAME, DOMAIN, ROUTE53_ZONE_NAME,
  ROUTE53_ZONE_ID, ACM_CERTIFICATE_ARN, ARTIFACT_BUCKET, ARTIFACT_PREFIX,
  OWNER_EMAIL, INSTANCE_TYPE, DB_INSTANCE_CLASS, PORTAINER_AGENT_ENABLED,
  PORTAINER_AGENT_PORT, PORTAINER_SERVER_CIDRS (comma-separated CIDRs)
EOF
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

die() {
  echo "[deploy] $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

aws_cli() {
  if [ -n "$AWS_PROFILE" ]; then
    aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
  else
    aws --region "$AWS_REGION" "$@"
  fi
}

terraform_cli() {
  if [ "$1" = plan ] && [ "$FDE_FLAG" = true ]; then
    terraform -chdir="$TF_DIR" "$@" -var=fde_enabled=true
  else
    terraform -chdir="$TF_DIR" "$@"
  fi
}

confirm() {
  local prompt="$1"
  if [ "$YES" = true ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    die "$prompt Re-run with --yes for non-interactive execution."
  fi
  local answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) die "Cancelled; no requested changes were applied." ;;
  esac
}

preflight_base() {
  require_command aws
  require_command terraform
  require_command python3
  require_command git
  aws_cli sts get-caller-identity --output json >/dev/null
  [ -z "$AWS_PROFILE" ] || export AWS_PROFILE
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
}

preflight_build() {
  require_command docker
  require_command zstd
  require_command openssl
  docker version >/dev/null || die "Docker daemon is not available"
}

discover_existing_aws_resources() {
  [ -n "$OWNER_EMAIL" ] || die "Set OWNER_EMAIL to the deployment owner's email address"
  [[ "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+[a-zA-Z0-9]$ ]] || die "Set DOMAIN to your public hostname"
  [[ "$DEPLOYMENT_NAME" =~ ^[a-z0-9][a-z0-9-]{1,25}$ ]] || die "DEPLOYMENT_NAME must be a 2-26 character lowercase slug"
  [ -n "$ROUTE53_ZONE_ID" ] || [ -n "$ROUTE53_ZONE_NAME" ] || die "Set ROUTE53_ZONE_ID or ROUTE53_ZONE_NAME"
  if [ -n "$ROUTE53_ZONE_NAME" ]; then
    [[ "$ROUTE53_ZONE_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+[a-zA-Z0-9]$ ]] || die "Invalid ROUTE53_ZONE_NAME"
  fi

  if [ -z "$ROUTE53_ZONE_ID" ]; then
    ROUTE53_ZONE_ID=$(aws_cli route53 list-hosted-zones-by-name \
      --dns-name "$ROUTE53_ZONE_NAME" \
      --query "HostedZones[?Name=='${ROUTE53_ZONE_NAME}.']|[0].Id" \
      --output text)
    ROUTE53_ZONE_ID=${ROUTE53_ZONE_ID#/hostedzone/}
  fi
  [ -n "$ROUTE53_ZONE_ID" ] && [ "$ROUTE53_ZONE_ID" != "None" ] \
    || die "No public Route53 zone found for $ROUTE53_ZONE_NAME"

  if [ -z "$ACM_CERTIFICATE_ARN" ]; then
    [ -n "$ROUTE53_ZONE_NAME" ] || die "Set ACM_CERTIFICATE_ARN or ROUTE53_ZONE_NAME"
    ACM_CERTIFICATE_ARN=$(aws_cli acm list-certificates \
      --certificate-statuses ISSUED \
      --query "CertificateSummaryList[?DomainName=='*.${ROUTE53_ZONE_NAME}']|[0].CertificateArn" \
      --output text)
  fi
  [ -n "$ACM_CERTIFICATE_ARN" ] && [ "$ACM_CERTIFICATE_ARN" != "None" ] \
    || die "No ISSUED wildcard ACM certificate found for *.${ROUTE53_ZONE_NAME} in $AWS_REGION"

  local certificate_status
  certificate_status=$(aws_cli acm describe-certificate \
    --certificate-arn "$ACM_CERTIFICATE_ARN" \
    --query Certificate.Status \
    --output text)
  [ "$certificate_status" = "ISSUED" ] || die "ACM certificate is not ISSUED: $ACM_CERTIFICATE_ARN"

  if [ -n "$ARTIFACT_BUCKET" ]; then
    aws_cli s3api head-bucket --bucket "$ARTIFACT_BUCKET" >/dev/null
  fi

  export TF_VAR_region="$AWS_REGION"
  export TF_VAR_deployment_name="$DEPLOYMENT_NAME"
  export TF_VAR_domain="$DOMAIN"
  export TF_VAR_route53_zone_id="$ROUTE53_ZONE_ID"
  export TF_VAR_acm_certificate_arn="$ACM_CERTIFICATE_ARN"
  export TF_VAR_artifact_bucket="$ARTIFACT_BUCKET"
  export TF_VAR_artifact_prefix="$ARTIFACT_PREFIX"
  export TF_VAR_owner_email="$OWNER_EMAIL"
  export TF_VAR_instance_type="$INSTANCE_TYPE"
  export TF_VAR_db_instance_class="$DB_INSTANCE_CLASS"

  if [ -n "$PORTAINER_AGENT_ENABLED" ]; then
    case "$PORTAINER_AGENT_ENABLED" in
      true|false) export TF_VAR_portainer_agent_enabled="$PORTAINER_AGENT_ENABLED" ;;
      *) die "PORTAINER_AGENT_ENABLED must be true or false" ;;
    esac
  fi
  if [ -n "$PORTAINER_AGENT_PORT" ]; then
    export TF_VAR_portainer_agent_port="$PORTAINER_AGENT_PORT"
  fi
  if [ -n "$PORTAINER_SERVER_CIDRS" ]; then
    TF_VAR_portainer_server_cidrs=$(python3 - "$PORTAINER_SERVER_CIDRS" <<'PY'
import json
import sys

print(json.dumps([cidr.strip() for cidr in sys.argv[1].split(",") if cidr.strip()]))
PY
)
    export TF_VAR_portainer_server_cidrs
  fi
}

terraform_init() {
  terraform_cli init -input=false
}

plan_infrastructure() {
  terraform_cli plan -input=false -out="$PLAN_FILE"
}

tf_output() {
  terraform_cli output -raw "$1"
}

configure_runtime_secret() {
  local app_secret_arn app_secret current_master_key env_file
  app_secret_arn=$(tf_output app_env_secret_arn)

  app_secret=$(aws_cli secretsmanager get-secret-value \
    --secret-id "$app_secret_arn" --query SecretString --output text) \
    || die "Cannot read the runtime secret; refusing to replace the encryption key"
  current_master_key=$(printf '%s\n' "$app_secret" \
    | awk -F= '$1 == "ADMIN_SECRETS_MASTER_KEY" { sub(/^[^=]*=/, ""); print; exit }')
  if [ -z "$current_master_key" ]; then
    [ "$app_secret" = "# placeholder - populated by deploy.sh" ] \
      || die "Runtime encryption key is missing; restore it from backup"
    require_command openssl
    current_master_key=$(openssl rand -base64 32 | tr -d '\n')
  fi

  TEMP_DIR=${TEMP_DIR:-$(mktemp -d)}
  env_file="$TEMP_DIR/app.env"
  umask 077
  APP_ENV_CONTENT="$app_secret" MASTER_KEY="$current_master_key" PUBLIC_DOMAIN="$DOMAIN" \
    python3 - "$env_file" <<'PYTHON'
import os
import sys
import base64
key = os.environ["MASTER_KEY"]
try:
    valid = len(base64.b64decode(key, validate=True)) == 32
except ValueError:
    valid = False
if not valid:
    raise SystemExit("Invalid encryption key; restore it from backup")
values = {}
for line in os.environ["APP_ENV_CONTENT"].splitlines():
    if line and not line.startswith("#") and "=" in line:
        name, value = line.split("=", 1)
        values[name] = value
values.pop("DATABASE_URL", None)
values.update(NODE_ENV="production", PORT="3000", PGSSLMODE="verify-full",
              PGSSLROOTCERT="/run/secrets/rds-ca.pem", ADMIN_SECRETS_MASTER_KEY=key,
              GC_PUBLIC_BASE_URL="https://" + os.environ["PUBLIC_DOMAIN"])
values.setdefault("POSTGRES_POOL_MAX", "10")
with open(sys.argv[1], "w", encoding="utf-8") as output:
    output.write("".join(f"{name}={value}\n" for name, value in values.items()))
PYTHON

  aws_cli secretsmanager put-secret-value \
    --secret-id "$app_secret_arn" \
    --secret-string "file://$env_file" \
    --query VersionId \
    --output text >/dev/null
  echo "[deploy] Runtime environment stored in Secrets Manager: $app_secret_arn"
}

build_and_upload_artifact() {
  require_command docker
  require_command zstd
  docker version >/dev/null

  local short_sha build_id image_name artifact_dir checksum prefix
  short_sha=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)
  build_id="${short_sha}-$(date -u +%Y%m%d%H%M%S)"
  image_name="telnyx-genesys-integrations:$build_id"
  TEMP_DIR=${TEMP_DIR:-$(mktemp -d)}
  artifact_dir="$TEMP_DIR/artifact"
  mkdir -p "$artifact_dir"

  # The Docker context excludes .git, so identity is captured here on the host
  # and passed in. Without it every image would call itself a development build
  # even when it was cut from a release tag.
  local build_info display_version commit built_at
  build_info=$(cd "$REPO_ROOT" && node scripts/build-info.mjs)
  display_version=$(node -p 'JSON.parse(process.argv[1]).displayVersion' "$build_info")
  commit=$(node -p 'JSON.parse(process.argv[1]).commit || "unknown"' "$build_info")
  built_at=$(node -p 'JSON.parse(process.argv[1]).builtAt' "$build_info")

  echo "[deploy] Building $image_name ($display_version) for linux/amd64"
  docker build --platform linux/amd64 --file "$REPO_ROOT/Dockerfile" \
    --build-arg GI_BUILD_INFO="$build_info" \
    --label org.opencontainers.image.version="$display_version" \
    --label org.opencontainers.image.revision="$commit" \
    --label org.opencontainers.image.created="$built_at" \
    --tag "$image_name" "$REPO_ROOT"
  docker save "$image_name" | zstd -T0 -3 -o "$artifact_dir/image.tar.zst"

  if command -v sha256sum >/dev/null 2>&1; then
    checksum=$(sha256sum "$artifact_dir/image.tar.zst" | awk '{print $1}')
  else
    checksum=$(shasum -a 256 "$artifact_dir/image.tar.zst" | awk '{print $1}')
  fi
  printf '%s  %s\n' "$checksum" "image.tar.zst" > "$artifact_dir/image.tar.zst.sha256"

  python3 - "$artifact_dir/manifest.json" "$image_name" "$short_sha" "$build_id" "$build_info" <<'PY'
import json
import sys

path, image, git_sha, build_id, build_info = sys.argv[1:]
build = json.loads(build_info)
with open(path, "w", encoding="utf-8") as fh:
    json.dump({
        "app": "telnyx-genesys-integrations",
        "image": image,
        "git_sha": git_sha,
        "build_id": build_id,
        "docker_platform": "linux/amd64",
        # displayVersion, not version: an untagged build has version "1.0.0"
        # and displayVersion "1.0.0-dev", and the artifact label must not
        # present a development build as a release. The nested snapshot keeps
        # both, and the timestamp comes from it too, so the manifest cannot
        # describe a different build than the one it sits beside.
        "version": build["displayVersion"],
        "built_at": build["builtAt"],
        "build": build,
    }, fh, indent=2)
    fh.write("\n")
PY

  ARTIFACT_BUCKET=$(tf_output artifact_bucket)
  ARTIFACT_PREFIX=$(tf_output artifact_prefix)
  prefix="s3://$ARTIFACT_BUCKET/$ARTIFACT_PREFIX/$build_id"
  echo "[deploy] Uploading artifact to $prefix"
  aws_cli s3 cp "$artifact_dir/image.tar.zst" "$prefix/image.tar.zst" --only-show-errors
  aws_cli s3 cp "$artifact_dir/image.tar.zst.sha256" "$prefix/image.tar.zst.sha256" --only-show-errors
  aws_cli s3 cp "$artifact_dir/manifest.json" "$prefix/manifest.json" --content-type application/json --only-show-errors
  ARTIFACT_S3_PREFIX="$prefix"
}

wait_for_ssm() {
  local instance_id="$1" status
  echo "[deploy] Waiting for SSM registration: $instance_id"
  for _ in $(seq 1 48); do
    status=$(aws_cli ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=$instance_id" \
      --query 'InstanceInformationList[0].PingStatus' \
      --output text 2>/dev/null || true)
    if [ "$status" = "Online" ]; then
      return 0
    fi
    sleep 5
  done
  die "EC2 instance did not become Online in SSM within 4 minutes: $instance_id"
}

deploy_artifact() {
  local prefix="$1" release_id instance_id app_secret_arn db_secret_arn portainer_enabled portainer_port encoded script command_json command_id result status stdout stderr
  release_id=${prefix##*/}
  instance_id=$(tf_output instance_id)
  app_secret_arn=$(tf_output app_env_secret_arn)
  db_secret_arn=$(tf_output db_secret_arn)
  portainer_enabled=$(tf_output portainer_agent_enabled)
  portainer_port=$(tf_output portainer_agent_port)
  wait_for_ssm "$instance_id"

  encoded=$(base64 < "$REMOTE_DEPLOY_SCRIPT" | tr -d '\n')
  script="sudo cloud-init status --wait >/dev/null 2>&1 || true; printf '%s' '$encoded' | base64 -d > /tmp/gix-deploy.sh && chmod +x /tmp/gix-deploy.sh && sudo env AWS_REGION='$AWS_REGION' APP_ENV_SECRET='$app_secret_arn' DB_SECRET='$db_secret_arn' PORTAINER_AGENT_ENABLED='$portainer_enabled' PORTAINER_AGENT_PORT='$portainer_port' /tmp/gix-deploy.sh '$prefix'"
  command_json=$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]]}))' "$script")
  command_id=$(aws_cli ssm send-command \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "Deploy Genesys Integrations $release_id" \
    --parameters "$command_json" \
    --query Command.CommandId \
    --output text)

  echo "[deploy] SSM deploy command: $command_id"
  for _ in $(seq 1 160); do
    result=$(aws_cli ssm get-command-invocation \
      --command-id "$command_id" \
      --instance-id "$instance_id" \
      --query '{status:Status,stdout:StandardOutputContent,stderr:StandardErrorContent}' \
      --output json 2>/dev/null || true)
    if [ -z "$result" ]; then
      sleep 5
      continue
    fi
    status=$(RESULT_JSON="$result" python3 -c 'import json,os; print(json.loads(os.environ["RESULT_JSON"])["status"])')
    case "$status" in
      Success|Failed|TimedOut|Cancelled)
        stdout=$(RESULT_JSON="$result" python3 -c 'import json,os; print(json.loads(os.environ["RESULT_JSON"]).get("stdout", ""), end="")')
        stderr=$(RESULT_JSON="$result" python3 -c 'import json,os; print(json.loads(os.environ["RESULT_JSON"]).get("stderr", ""), end="")')
        [ -n "$stdout" ] && printf '%s\n' "$stdout"
        [ -n "$stderr" ] && printf '%s\n' "$stderr" >&2
        [ "$status" = "Success" ] || die "Remote deployment failed with SSM status $status"
        echo "[deploy] Application deployed successfully: https://$DOMAIN"
        return 0
        ;;
    esac
    sleep 5
  done
  die "SSM deployment did not finish within the expected time"
}

deploy_current_tree() {
  build_and_upload_artifact
  deploy_artifact "$ARTIFACT_S3_PREFIX"
}

load_existing_deployment() {
  AWS_REGION=$(tf_output region)
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
  DOMAIN=$(tf_output app_url)
  DOMAIN=${DOMAIN#https://}
}

show_status() {
  local instance_id target_group_arn app_url
  instance_id=$(tf_output instance_id)
  target_group_arn=$(tf_output target_group_arn)
  app_url=$(tf_output app_url)
  echo "Application: $app_url"
  aws_cli ec2 describe-instances \
    --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].{Instance:InstanceId,State:State.Name,Type:InstanceType,PrivateIp:PrivateIpAddress}' \
    --output table
  aws_cli elbv2 describe-target-health \
    --target-group-arn "$target_group_arn" \
    --query 'TargetHealthDescriptions[].{Target:Target.Id,Port:Target.Port,State:TargetHealth.State,Reason:TargetHealth.Reason}' \
    --output table
  if curl -fsS --max-time 10 "$app_url/api/health"; then
    echo
  else
    echo "Public health check is not ready: $app_url/api/health" >&2
    return 1
  fi
}

run_bootstrap() {
  require_command session-manager-plugin
  local instance_id parameters
  instance_id=$(tf_output instance_id)
  wait_for_ssm "$instance_id"
  parameters='{"command":["sudo /opt/gix/run-installer.sh"]}'
  aws_cli ssm start-session \
    --target "$instance_id" \
    --document-name AWS-StartInteractiveCommand \
    --parameters "$parameters"
}

COMMAND=${1:-}
[ -n "$COMMAND" ] || { usage; exit 2; }
shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=true ;;
    --fde|-fde) FDE_ENABLED=true; FDE_FLAG=true ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

case "$FDE_ENABLED" in
  true|false) export TF_VAR_fde_enabled="$FDE_ENABLED" ;;
  *) die "TF_VAR_fde_enabled must be true or false" ;;
esac
if [ "$FDE_FLAG" = true ] && [[ "$COMMAND" =~ ^(update|bootstrap|status)$ ]]; then
  echo "[deploy] This command does not change infrastructure tags; use up --fde to enable discovery."
fi

case "$COMMAND" in
  plan)
    preflight_base
    discover_existing_aws_resources
    terraform_init
    plan_infrastructure
    ;;
  up)
    preflight_base
    preflight_build
    discover_existing_aws_resources
    terraform_init
    plan_infrastructure
    confirm "Apply this Terraform plan and deploy the application to $DOMAIN?"
    terraform_cli apply -input=false "$PLAN_FILE"
    configure_runtime_secret
    deploy_current_tree
    echo "[deploy] Run ./deploy/aws/deploy.sh bootstrap for the one-time interactive Genesys/Telnyx setup."
    ;;
  update)
    preflight_base
    preflight_build
    load_existing_deployment
    confirm "Deploy the current application to $DOMAIN?"
    deploy_current_tree
    ;;
  bootstrap)
    preflight_base
    load_existing_deployment
    run_bootstrap
    ;;
  status)
    preflight_base
    load_existing_deployment
    show_status
    ;;
  destroy)
    preflight_base
    discover_existing_aws_resources
    terraform_init
    terraform_cli plan -destroy -input=false -out="$PLAN_FILE"
    confirm "Destroy the Terraform-managed Genesys Integrations infrastructure?"
    terraform_cli apply -input=false "$PLAN_FILE"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
