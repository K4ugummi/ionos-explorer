#!/bin/sh
# Fails if the repository tracks a snapshot (other than the two synthetic
# demo fixtures) or a credential file. Real snapshots hold infrastructure
# data and must never be committed.
set -eu
cd "$(dirname "$0")/.."
bad=$(git ls-files -z '*.ionx' '*.age' '*.token' '.env' '*.env' '.env.*' '**/.env' '**/.env.*' |
  tr '\0' '\n' |
  grep -v -x -e fixtures/demo-contract.ionx -e fixtures/demo-contract-previous.ionx -e deploy/compose/.env.example || true)
if [ -n "$bad" ]; then
  echo "These files must not be in the repository (snapshots or credentials):" >&2
  echo "$bad" >&2
  exit 1
fi
echo "check-repo: no snapshots or credential files tracked"
