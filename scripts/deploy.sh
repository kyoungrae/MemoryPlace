#!/bin/sh
set -eu

image=${1:?Usage: sh scripts/deploy.sh IMAGE}
docker_bin=${DOCKER_BIN:-docker}
container=memoryplace-app
network=memoryplace_default
secret_volume=memoryplace_app_secrets
port=4301

"$docker_bin" network inspect "$network" >/dev/null
"$docker_bin" volume inspect "$secret_volume" >/dev/null
"$docker_bin" image inspect "$image" >/dev/null

if "$docker_bin" container inspect "$container" >/dev/null 2>&1; then
  label=$("$docker_bin" inspect -f '{{index .Config.Labels "com.memoryplace.app"}}' "$container")
  [ "$label" = true ] || { echo "Refusing to replace an unrelated container: $container" >&2; exit 1; }
  previous_image=$("$docker_bin" inspect -f '{{.Config.Image}}' "$container")
else
  previous_image=
fi

start_app() {
  "$docker_bin" run -d \
    --name "$container" \
    --label com.memoryplace.app=true \
    --restart unless-stopped \
    --network "$network" \
    --publish "127.0.0.1:$port:3001" \
    --mount "type=volume,source=$secret_volume,target=/run/secrets,readonly" \
    --env NODE_ENV=production \
    --env HOST=0.0.0.0 \
    --env PORT=3001 \
    --env MONGO_URL_FILE=/run/secrets/mongo_url \
    --read-only --tmpfs /tmp --security-opt no-new-privileges \
    "$1" >/dev/null
}

wait_healthy() {
  attempt=0
  while [ "$attempt" -lt 35 ]; do
    status=$("$docker_bin" inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && return 1
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

if [ -n "$previous_image" ]; then "$docker_bin" rm -f "$container" >/dev/null; fi
if start_app "$image" && wait_healthy; then
  echo "Deployed $image on loopback port $port"
  exit 0
fi

echo "New app failed its health check" >&2
"$docker_bin" logs --tail 30 "$container" >&2 || true
"$docker_bin" rm -f "$container" >/dev/null 2>&1 || true
if [ -n "$previous_image" ]; then
  echo "Restoring $previous_image" >&2
  start_app "$previous_image" && wait_healthy || echo "Rollback needs attention" >&2
fi
exit 1
