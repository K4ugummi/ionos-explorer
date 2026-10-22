#!/bin/sh
# Plants a snapshot, an encrypted snapshot, a token and an .env file in the
# working copy and checks that .dockerignore keeps them (and everything
# else that is not source) out of the Docker build context.
set -eu
cd "$(dirname "$0")/.."
planted="ionos-context-check.ionx explorer/ionos-context-check.ionx.age exporter/context-check.token .env.context-check"
trap 'rm -f $planted' EXIT
for f in $planted; do echo "not for an image" >"$f"; done
files=$(printf 'FROM busybox:1.37\nCOPY . /ctx\nRUN cd /ctx && find . -type f -not -path "*/node_modules/*" | sort\n' |
  docker build --no-cache --progress=plain -f - . 2>&1 | sed -n 's/^#[0-9]* [0-9.]* \.\//.\//p')
[ -n "$files" ] || { echo "check-context: could not list the build context" >&2; exit 1; }
bad=$(echo "$files" | grep -E '\.(ionx|age|token)$|/\.env|/\.git/|/\.plans/|/bin/|/dist/|webui/dist/' |
  grep -v -x -e ./fixtures/demo-contract.ionx -e ./fixtures/demo-contract-previous.ionx || true)
if [ -n "$bad" ]; then
  echo "check-context: in the build context but must not be:" >&2
  echo "$bad" >&2
  exit 1
fi
echo "check-context: $(echo "$files" | wc -l) files, no snapshots, credentials or build output"
