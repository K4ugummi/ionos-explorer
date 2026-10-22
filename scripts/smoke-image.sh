#!/bin/sh
# Runs the image as hardened as the deployment files do (read-only root,
# no capabilities, no new privileges), in hosted mode with a fresh volume,
# and checks the probes, the setup link, the users command, Docker's
# health check, a random UID with group 0 (OpenShift) and a clean stop.
#   scripts/smoke-image.sh [image]     (default ionos-explorer)
set -eu
image=${1:-ionos-explorer}
name=ionos-explorer-smoke-$$
port=${SMOKE_PORT:-18080}
cleanup() {
  docker rm -f "$name" "$name-uid" >/dev/null 2>&1 || true
  docker volume rm -f "$name" "$name-uid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "smoke: $*" >&2; docker logs "$name" >&2 2>&1 || true; exit 1; }
wait_ready() { # container port
  i=0
  until curl -sf "http://127.0.0.1:$2/readyz" >/dev/null; do
    i=$((i + 1))
    [ $i -lt 60 ] || fail "$1 not ready"
    [ "$(docker inspect -f '{{.State.Running}}' "$1")" = true ] || fail "$1 exited"
    sleep 1
  done
}

docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:$port:8080" -v "$name:/data" \
  -e IONOS_EXPLORER_PUBLIC_URL="http://localhost:$port" -e IONOS_EXPLORER_LOG_FORMAT=json \
  --health-interval 2s "$image" >/dev/null
wait_ready "$name" "$port"
[ "$(curl -s "http://127.0.0.1:$port/healthz")" = ok ] || fail "healthz"
docker logs "$name" 2>&1 | grep -q "\"link\":\"http://localhost:$port/#setup=" || fail "no setup link in the log"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: localhost:$port" "http://127.0.0.1:$port/")
[ "$code" = 200 ] || fail "page: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: elsewhere.example" "http://127.0.0.1:$port/")
[ "$code" = 421 ] || fail "wrong host: $code"
docker exec "$name" ionos-explorer users add smoke-user >/dev/null || fail "users add"
docker exec "$name" ionos-explorer users list | grep -q smoke-user || fail "users list"
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ]; do
  i=$((i + 1)); [ $i -lt 30 ] || fail "not healthy"; sleep 1
done
docker stop -t 30 "$name" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0 ] || fail "exit code after SIGTERM"
docker logs "$name" 2>&1 | grep -q '"msg":"Stopping' || fail "no stop message"
echo "smoke: hardened run, probes, setup link, users, health, stop: ok"

# Any UID with group 0, as OpenShift runs it.
uport=$((port + 1))
docker run -d --name "$name-uid" --user 123456:0 --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:$uport:8080" -v "$name-uid:/data" -e IONOS_EXPLORER_PUBLIC_URL="http://localhost:$uport" "$image" >/dev/null
wait_ready "$name-uid" "$uport"
echo "smoke: random UID with group 0: ok"
