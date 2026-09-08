#!/usr/bin/env bash
set -euo pipefail
umask 077
APP_DIR=/opt/genesys-integrations
RELEASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec 9>"$APP_DIR/deploy.lock"
flock -n 9 || { echo "Another deployment or installer is running" >&2; exit 1; }
cd "$RELEASE_DIR"
# The entrypoint verifies the entire release archive before extracting it.
python3 provider.py env deployment.json app.env
zstd -dc image.tar.zst | docker load
rm image.tar.zst
previous=$(readlink -f "$APP_DIR/current" || true)
compose() { docker compose --env-file "$RELEASE_DIR/compose.env" -f "$RELEASE_DIR/compose.yaml" "$@"; }
if [ "$(python3 -c 'import json; print(json.load(open("deployment.json"))["target"])')" = gcp ]; then
  compose --profile gcp up -d cloud-sql-proxy
fi
wait_for_health() {
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 5 http://127.0.0.1:3000/api/health >/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}
rollback() {
  if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$RELEASE_DIR" ]; then
    echo "Restoring previous application image" >&2
    docker compose --env-file "$previous/compose.env" -f "$previous/compose.yaml" up -d app proxy || return 1
    wait_for_health
  fi
}
if ! compose up -d app || ! wait_for_health || ! compose up -d proxy; then
  rollback || true
  echo "Deployment failed; inspect container logs on the VM" >&2
  exit 1
fi
ln -sfn "$RELEASE_DIR" "$APP_DIR/current"
echo "GIX_DEPLOY_OK"
