#!/usr/bin/env bash
# Build bin/read-index-<platform>-<arch> for every platform MyGo Music ships.
# Pure Go, no cgo, so cross-compiling needs nothing but the Go toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p bin
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64 windows/arm64 windows/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  out="bin/read-index-$goos-$goarch"
  if [ "$goos" = windows ]; then out="$out.exe"; fi
  echo "building $out"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags='-s -w' -o "$out" ./cmd/read-index
  chmod 755 "$out"
done
echo "---"
ls -lh bin/
