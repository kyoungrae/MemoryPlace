#!/bin/sh
set -eu

image=${1:?Usage: sh scripts/test-image.sh IMAGE RUN_ID}
run_id=${2:?Usage: sh scripts/test-image.sh IMAGE RUN_ID}
docker_bin=${DOCKER_BIN:-docker}
network="memoryplace-ci-$run_id"
mongo="memoryplace-ci-mongo-$run_id"
password=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')

cleanup() {
  "$docker_bin" rm -f "$mongo" >/dev/null 2>&1 || true
  "$docker_bin" network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$docker_bin" network create "$network" >/dev/null
"$docker_bin" run -d --name "$mongo" --network "$network" --network-alias mongo \
  -e MONGO_INITDB_ROOT_USERNAME=test -e "MONGO_INITDB_ROOT_PASSWORD=$password" mongo:8.0 >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  if "$docker_bin" exec "$mongo" mongosh --quiet -u test -p "$password" --authenticationDatabase admin --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q '^1$'; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
[ "$ready" = true ] || { echo 'Test MongoDB did not start' >&2; exit 1; }

"$docker_bin" run --rm --network "$network" \
  -e "MONGO_URL=mongodb://test:$password@mongo:27017/?authSource=admin" \
  "$image" npm test
