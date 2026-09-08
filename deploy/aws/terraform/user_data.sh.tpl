#!/usr/bin/env bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg unzip jq zstd python3

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install || true

snap install amazon-ssm-agent --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service || true

install -d -m 0750 /opt/gix /opt/genesys-integrations/releases
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/gix/rds-ca.pem
chmod 0644 /opt/gix/rds-ca.pem

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

cat > /opt/gix/run-installer.sh <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/genesys-integrations
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
IMAGE=$(docker inspect --format '{{.Config.Image}}' genesys-integrations-app 2>/dev/null || true)
if [ -z "$IMAGE" ] && [ -s "$CURRENT_IMAGE_FILE" ]; then
  IMAGE=$(tr -d '\n' < "$CURRENT_IMAGE_FILE")
fi
if [ -z "$IMAGE" ]; then
  echo "No deployed application image found. Run deploy.sh up or update first." >&2
  exit 2
fi
/opt/gix/refresh-env.sh "${region}" "${app_env_secret}" "${db_secret}"
docker run --rm -it \
  --env-file "$APP_DIR/app.env" \
  -e INSTALLER_ENV_READ_ONLY=1 \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL \
  -v gix-a:/app/.genesys-audio \
  -v gix-w:/app/.genesys-widget \
  -v gix-d:/app/.genesys-admin \
  -v gix-s:/app/.genesys-shared \
  -v /opt/gix/rds-ca.pem:/run/secrets/rds-ca.pem:ro \
  "$IMAGE" node scripts/manage-genesys-deploy.mjs
docker restart genesys-integrations-app >/dev/null
echo "Installer complete; application container restarted."
INSTALLER
chmod 0750 /opt/gix/run-installer.sh

# Optional agent-only integration with an existing Portainer server. Network
# access is independently restricted by the application Security Group.
if [ "${portainer_agent_enabled}" = "true" ]; then
  DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
  VOLUMES_DIR="$DOCKER_ROOT/volumes"
  mkdir -p "$VOLUMES_DIR"
  docker rm -f portainer_agent || true
  docker run -d \
    --name portainer_agent \
    --restart=always \
    -p ${portainer_agent_port}:9001 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUMES_DIR":/var/lib/docker/volumes \
    portainer/agent:lts
fi

echo "Genesys Integrations machine bootstrap complete" > /var/log/genesys-integrations-bootstrap.done
