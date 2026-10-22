#!/bin/sh
# Validates the deployment files: the Kustomize renders against the
# Kubernetes schemas, the Compose files and the Swarm stack.
set -eu
cd "$(dirname "$0")/.."
KUBECONFORM=${KUBECONFORM:-go run github.com/yannh/kubeconform/cmd/kubeconform@v0.8.0}
K8S_VERSION=${K8S_VERSION:-1.34.0}
for overlay in base overlays/example overlays/dev; do
  printf '%s: ' "kubernetes/$overlay"
  kubectl kustomize "deploy/kubernetes/$overlay" | (cd exporter && $KUBECONFORM -strict -summary -kubernetes-version "$K8S_VERSION" -)
done
PUBLIC_URL=https://explorer.example.com docker compose -f deploy/compose/compose.yaml config -q
PUBLIC_URL=https://explorer.example.com DOMAIN=explorer.example.com \
  docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.caddy.yaml config -q
docker compose -f deploy/compose/compose.dev.yaml config -q
docker compose -f deploy/compose/compose.dev.yaml -f deploy/compose/compose.dev-idp.yaml config -q
echo "compose: ok"
PUBLIC_URL=https://explorer.example.com docker stack config -c deploy/swarm/stack.yaml >/dev/null
echo "swarm: ok"
