#!/bin/sh
# End to end on Kubernetes (kind): deploy/kubernetes/overlays/dev with the
# images built from this checkout, the browser check through a port-forward,
# a rollout restart (the accounts must survive it), the check again. The
# cluster and its kubeconfig are temporary.
#   e2e/kind.sh        (needs Docker, Go, kubectl, Node, npm ci in e2e/)
set -eu
cd "$(dirname "$0")"
here=$PWD
KIND=${KIND:-go run sigs.k8s.io/kind@v0.33.0}
cluster=ionos-explorer-e2e
export KUBECONFIG="$here/results/kubeconfig"
url=http://localhost:8080
ns="-n ionos-explorer"
pf=
mkdir -p results
cleanup() {
  [ -z "$pf" ] || kill "$pf" 2>/dev/null || true
  kubectl $ns logs deploy/ionos-explorer --all-containers >"$here/results/kind.log" 2>&1 || true
  $KIND delete cluster --name "$cluster" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG"
}
trap cleanup EXIT

forward() {
  [ -z "$pf" ] || kill "$pf" 2>/dev/null || true
  kubectl $ns port-forward svc/ionos-explorer 8080:80 >"$here/results/port-forward.log" 2>&1 &
  pf=$!
  i=0
  until curl -sf http://127.0.0.1:8080/readyz >/dev/null; do
    i=$((i + 1)); [ $i -lt 60 ] || { echo "port-forward not ready" >&2; exit 1; }; sleep 1
  done
}

(cd .. && docker build -q -t ionos-explorer:dev . >/dev/null && docker build -q --target fakeapi -t ionos-fakeapi:dev . >/dev/null)
$KIND create cluster --name "$cluster" --wait 120s
$KIND load docker-image --name "$cluster" ionos-explorer:dev ionos-fakeapi:dev
kubectl apply -k ../deploy/kubernetes/overlays/dev
kubectl $ns rollout status deploy/ionos-explorer --timeout=180s
forward
setup=$(kubectl $ns logs deploy/ionos-explorer -c explorer | grep -o "$url/#setup=[A-Za-z0-9_-]*" | tail -1)
[ -n "$setup" ] || { echo "no setup link in the log" >&2; exit 1; }
node hosted.mjs setup "$setup"

kubectl $ns rollout restart deploy/ionos-explorer
kubectl $ns rollout status deploy/ionos-explorer --timeout=180s
forward
node hosted.mjs login "$url"
echo "e2e kind: ok"
