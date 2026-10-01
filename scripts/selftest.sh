#!/bin/sh
# Checks the running container without changing its state.
set -eu

SERVICE=${SERVICE:-adguard-cert-setter}
container_id="$(docker compose ps -q "${SERVICE}")"

if [ -z "${container_id}" ]; then
    echo "ERROR: Service ${SERVICE} is not running." >&2
    exit 1
fi

echo "== Healthcheck"
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}")"
echo "   ${health}"
[ "${health}" = "healthy" ]

echo "== User"
uid="$(docker compose exec -T "${SERVICE}" id -u)"
echo "   UID ${uid}"
[ "${uid}" != "0" ]

echo "== Database permissions"
docker compose exec -T "${SERVICE}" stat -c '   %a %U:%G %n' /data/app.db
mode="$(docker compose exec -T "${SERVICE}" stat -c '%a' /data/app.db)"
[ "${mode}" = "600" ]

echo "== Complete"
