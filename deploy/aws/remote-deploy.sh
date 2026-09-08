#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_PREFIX="${1:-}"
if [ -z "$ARTIFACT_PREFIX" ] || [[ "$ARTIFACT_PREFIX" != s3://* ]]; then
  echo "Usage: remote-deploy.sh s3://bucket/prefix/release" >&2
  exit 2
fi

: "${AWS_REGION:?AWS_REGION is required}"
: "${APP_ENV_SECRET:?APP_ENV_SECRET is required}"
: "${DB_SECRET:?DB_SECRET is required}"

PORTAINER_AGENT_ENABLED=${PORTAINER_AGENT_ENABLED:-false}
PORTAINER_AGENT_PORT=${PORTAINER_AGENT_PORT:-9001}
case "$PORTAINER_AGENT_ENABLED" in
  true|false) ;;
  *) echo "PORTAINER_AGENT_ENABLED must be true or false" >&2; exit 2 ;;
esac
if ! [[ "$PORTAINER_AGENT_PORT" =~ ^[0-9]+$ ]] || [ "$PORTAINER_AGENT_PORT" -lt 1 ] || [ "$PORTAINER_AGENT_PORT" -gt 65535 ]; then
  echo "PORTAINER_AGENT_PORT must be between 1 and 65535" >&2
  exit 2
fi

APP_DIR=/opt/genesys-integrations
RELEASE_ID=$(basename "$ARTIFACT_PREFIX")
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
CONTAINER_NAME=genesys-integrations-app
APP_PORT=3000
mkdir -p "$RELEASE_DIR"
cd "$RELEASE_DIR"

cleanup_partial_artifact() {
  rm -f "$RELEASE_DIR/image.tar.zst"
}
trap cleanup_partial_artifact EXIT

install_runtime_prerequisites() {
  local needs_packages=false
  for command in curl gpg python3 unzip zstd; do
    if ! command -v "$command" >/dev/null 2>&1; then
      needs_packages=true
    fi
  done
  if ! command -v docker >/dev/null 2>&1 || ! command -v aws >/dev/null 2>&1; then
    needs_packages=true
  fi

  if [ "$needs_packages" = "true" ]; then
    command -v apt-get >/dev/null 2>&1 || {
      echo "Cannot install runtime prerequisites: apt-get is unavailable" >&2
      exit 3
    }
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg unzip jq zstd python3
  fi

  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  systemctl enable --now docker

  if ! command -v aws >/dev/null 2>&1; then
    local aws_install_dir
    aws_install_dir=$(mktemp -d)
    curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip \
      -o "$aws_install_dir/awscliv2.zip"
    unzip -q "$aws_install_dir/awscliv2.zip" -d "$aws_install_dir"
    "$aws_install_dir/aws/install"
    rm -rf "$aws_install_dir"
  fi
}

install_runtime_helpers() {
  install -d -m 0750 /opt/gix "$APP_DIR"
  cat > /opt/gix/refresh-env.sh <<'ENV_REFRESH'
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: refresh-env.sh AWS_REGION APP_ENV_SECRET DB_SECRET" >&2
  exit 2
fi

AWS_REGION="$1"
APP_ENV_SECRET="$2"
DB_SECRET="$3"
TARGET=/opt/genesys-integrations/app.env

APP_ENV_CONTENT=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$APP_ENV_SECRET" \
  --query SecretString \
  --output text)
DB_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$DB_SECRET" \
  --query SecretString \
  --output text)

APP_ENV_CONTENT="$APP_ENV_CONTENT" DB_SECRET_JSON="$DB_SECRET_JSON" \
  python3 - "$TARGET" <<'PY'
import json
import os
import sys
from urllib.parse import quote

target = sys.argv[1]
credentials = json.loads(os.environ["DB_SECRET_JSON"])
required = ("username", "password", "host", "port", "dbname")
missing = [key for key in required if key not in credentials]
if missing:
    raise SystemExit(f"Database secret is missing required fields: {', '.join(missing)}")

username = quote(str(credentials["username"]), safe="")
password = quote(str(credentials["password"]), safe="")
host = credentials["host"]
port = credentials["port"]
dbname = quote(str(credentials["dbname"]), safe="")
database_url = f"postgresql://{username}:{password}@{host}:{port}/{dbname}"
lines = [
    line
    for line in os.environ["APP_ENV_CONTENT"].splitlines()
    if line and not line.startswith("DATABASE_URL=")
]
lines.append(f"DATABASE_URL={database_url}")
with open(target, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
PY
chmod 0600 "$TARGET"
ENV_REFRESH
  chmod 0750 /opt/gix/refresh-env.sh

  if [ ! -s /opt/gix/rds-ca.pem ]; then
    curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/gix/rds-ca.pem
    chmod 0644 /opt/gix/rds-ca.pem
  fi
}

reconcile_portainer_agent() {
  if [ "$PORTAINER_AGENT_ENABLED" = "false" ]; then
    docker rm -f portainer_agent >/dev/null 2>&1 || true
    return
  fi
  local docker_root volumes_dir
  docker_root=$(docker info --format '{{.DockerRootDir}}')
  volumes_dir="$docker_root/volumes"
  mkdir -p "$volumes_dir"
  docker rm -f portainer_agent >/dev/null 2>&1 || true
  docker run -d \
    --name portainer_agent \
    --restart=always \
    -p "$PORTAINER_AGENT_PORT:9001" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$volumes_dir:/var/lib/docker/volumes" \
    portainer/agent:lts >/dev/null
}

cleanup_deployment_storage() {
  echo "Cleaning deployment storage before artifact download"
  # Release archives are transport files only. Runtime rollback uses the image
  # still referenced by the running application container.
  find "$APP_DIR/releases" -mindepth 2 -maxdepth 2 -type f \
    \( -name 'image.tar.zst' -o -name '*.partial' \) -delete 2>/dev/null || true
  docker container prune -f >/dev/null || true
  # -a is intentional: tagged images from earlier releases are otherwise kept
  # forever. Docker preserves images referenced by the running app and
  # Portainer containers, including the image required for rollback.
  docker image prune -af >/dev/null || true
  docker builder prune -af >/dev/null || true
  command -v apt-get >/dev/null 2>&1 && apt-get clean || true
}

assert_artifact_space() {
  local artifact_path bucket key artifact_size available required
  artifact_path=${ARTIFACT_PREFIX#s3://}
  bucket=${artifact_path%%/*}
  key=${artifact_path#*/}/image.tar.zst
  artifact_size=$(aws s3api head-object \
    --bucket "$bucket" \
    --key "$key" \
    --query ContentLength \
    --output text)
  available=$(df -PB1 "$APP_DIR" | awk 'NR==2 {print $4}')
  # docker load expands the transport archive into image layers. Reserve a
  # conservative multiple plus 512 MiB for containerd metadata and startup.
  required=$((artifact_size * 16 + 536870912))
  echo "Deployment disk preflight: available=$available required=$required artifact=$artifact_size bytes"
  if [ "$available" -lt "$required" ]; then
    df -h "$APP_DIR" >&2
    docker system df >&2 || true
    echo "Insufficient disk space after safe cleanup; enlarge the EC2 root volume or inspect /var/lib/containerd" >&2
    exit 4
  fi
}

install_runtime_prerequisites
install_runtime_helpers
reconcile_portainer_agent
cleanup_deployment_storage
assert_artifact_space

echo "Refreshing runtime environment from Secrets Manager"
/opt/gix/refresh-env.sh "$AWS_REGION" "$APP_ENV_SECRET" "$DB_SECRET"

echo "Downloading artifact from $ARTIFACT_PREFIX"
aws s3 cp "$ARTIFACT_PREFIX/manifest.json" manifest.json --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst" image.tar.zst --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst.sha256" image.tar.zst.sha256 --only-show-errors

echo "Verifying artifact checksum"
sha256sum -c image.tar.zst.sha256

IMAGE_NAME=$(python3 -c "import json; print(json.load(open('manifest.json'))['image'])")
previous_image=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)
if [ -z "$previous_image" ] && [ -f "$CURRENT_IMAGE_FILE" ]; then
  previous_image=$(tr -d '\n' < "$CURRENT_IMAGE_FILE")
fi

echo "Loading Docker image $IMAGE_NAME"
zstd -dc image.tar.zst | docker load
rm -f image.tar.zst

run_container() {
  local image="$1"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file "$APP_DIR/app.env" \
    --security-opt=no-new-privileges:true \
    --cap-drop=ALL \
    -p "$APP_PORT:3000" \
    -v gix-a:/app/.genesys-audio \
    -v gix-w:/app/.genesys-widget \
    -v gix-d:/app/.genesys-admin \
    -v gix-s:/app/.genesys-shared \
    -v gix-x:/app/.widget-assets \
    -v /opt/gix/rds-ca.pem:/run/secrets/rds-ca.pem:ro \
    "$image"
}

wait_for_health() {
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null; then
      return 0
    fi
    echo "Health check not ready ($attempt/120)"
    sleep 5
  done
  return 1
}

run_container "$IMAGE_NAME"
if wait_for_health; then
  echo "$IMAGE_NAME" > "$CURRENT_IMAGE_FILE"
  find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -nr | awk 'NR>2 {print $2}' \
    | while IFS= read -r old_release; do
        [ -n "$old_release" ] && rm -rf "$old_release"
      done
  docker image prune -af >/dev/null || true
  echo "DEPLOY_OK image=$IMAGE_NAME"
  exit 0
fi

echo "New image failed health checks: $IMAGE_NAME" >&2
if [ -n "$previous_image" ]; then
  echo "Rolling back to previous image: $previous_image" >&2
  run_container "$previous_image"
  wait_for_health || true
fi
exit 5
