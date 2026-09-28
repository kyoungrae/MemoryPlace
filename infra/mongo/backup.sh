#!/bin/sh
set -eu

: "${MEMORYPLACE_BACKUP_DIR:?Set a private backup directory outside the repository}"
docker_bin="${DOCKER_BIN:-docker}"
mongo_container="${MEMORYPLACE_MONGO_CONTAINER:-memoryplace-mongo}"
umask 077
mkdir -p "$MEMORYPLACE_BACKUP_DIR"
chmod 700 "$MEMORYPLACE_BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$MEMORYPLACE_BACKUP_DIR/memoryplace-$stamp.archive.gz"
temporary="$target.tmp"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

"$docker_bin" exec "$mongo_container" sh -c 'mongodump --quiet --username memoryplace_root --password "$(cat /run/secrets/mongo_root_password)" --authenticationDatabase admin --db memoryplace --archive --gzip' > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$target"
printf 'Backup created: %s\n' "$target"
