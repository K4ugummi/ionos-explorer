#!/bin/sh
# End to end with Docker Compose: deploy/compose/compose.dev.yaml (the image
# built from this checkout and the fake IONOS API), the browser check, a
# restart of the explorer (the accounts must survive it), the check again.
#   e2e/compose.sh     (needs Docker with Compose, Node, npm ci in e2e/)
set -eu
cd "$(dirname "$0")"
here=$PWD
compose="docker compose -p ionos-explorer-e2e -f ../deploy/compose/compose.dev.yaml"
url=http://localhost:8080
cleanup() { $compose logs >"$here/results/compose.log" 2>&1 || true; $compose down -v >/dev/null 2>&1 || true; }
mkdir -p results
trap cleanup EXIT

ready() {
  i=0
  until curl -sf http://127.0.0.1:8080/readyz >/dev/null; do
    i=$((i + 1)); [ $i -lt 120 ] || { echo "not ready" >&2; exit 1; }; sleep 1
  done
}

$compose up -d --build --quiet-pull
ready
setup=$($compose logs explorer 2>&1 | grep -o "$url/#setup=[A-Za-z0-9_-]*" | tail -1)
[ -n "$setup" ] || { echo "no setup link in the log" >&2; exit 1; }
node hosted.mjs setup "$setup"

$compose stop explorer
$compose start explorer
ready
node hosted.mjs login "$url"
echo "e2e compose: ok"
