#!/bin/sh
# Builds the release archives into dist/: ionos-explorer (UI embedded) and
# ionos-export for Linux, macOS and Windows on amd64 and arm64, each with
# LICENSE, NOTICE and README.md, plus SHA256SUMS.
#   scripts/build-release.sh <version>      (e.g. v1.2.3; needs Go and Node)
set -eu
version=${1:?usage: scripts/build-release.sh <version>}
cd "$(dirname "$0")/.."
root=$PWD
rm -rf dist && mkdir dist

(cd explorer && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
rm -rf exporter/internal/webui/dist
cp -R explorer/dist exporter/internal/webui/dist

for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  os=${target%/*} arch=${target#*/}
  name=ionos-explorer_${version#v}_${os}_${arch}
  ext=; [ "$os" = windows ] && ext=.exe
  out=$root/dist/$name
  mkdir -p "$out"
  (cd exporter &&
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false -tags embedui \
      -ldflags "-s -w -X main.version=$version" -o "$out/ionos-explorer$ext" ./cmd/ionos-explorer &&
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.version=$version" -o "$out/ionos-export$ext" ./cmd/ionos-export)
  cp LICENSE NOTICE README.md "$out/"
  if [ "$os" = windows ]; then
    (cd dist && zip -qr "$name.zip" "$name")
  else
    tar -C dist --owner=0 --group=0 --numeric-owner -czf "dist/$name.tar.gz" "$name"
  fi
  rm -rf "$out"
done
(cd dist && sha256sum -- *.tar.gz *.zip >SHA256SUMS)
cat dist/SHA256SUMS
