#!/usr/bin/env bash
set -euo pipefail
umask 077
APP_DIR=/opt/genesys-integrations
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
exec 9>"$APP_DIR/deploy.lock"
flock -n 9 || { echo "Another deployment or installer is running" >&2; exit 1; }
python3 provider.py env deployment.json app.env
docker compose --env-file compose.env -f compose.yaml --profile installer run --rm installer
docker compose --env-file compose.env -f compose.yaml up -d --force-recreate app
