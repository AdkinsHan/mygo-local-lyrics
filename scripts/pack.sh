#!/usr/bin/env bash
# Make zips the app can install. The general zip carries every platform's
# helper; the platform-named release assets carry just the one they need.
# Executable bits on the helpers are kept, as the app's installer reads them.
# The source fallback (a zipball of the repo) has no bin/, so publishing the
# release assets is what makes installs from GitHub work.
set -euo pipefail
cd "$(dirname "$0")/.."

for f in plugin.json index.js locales/zh-CN.json; do
  if [[ ! -f $f ]]; then
    echo "missing $f; run pack.sh from the repository root" >&2
    exit 1
  fi
done
mkdir -p dist
rm -f dist/*.zip
common=(plugin.json index.js locales)

# A fresh clone has no bin/: it is gitignored, and the helpers are built with
# `npm run build:helpers`. Without them a zip still installs but every lookup
# fails. Refuse to publish an asset we know is broken.
for platform in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64 windows-arm64 windows-amd64; do
  helper="bin/read-index-$platform"
  if [[ $platform == windows-* ]]; then helper="$helper.exe"; fi
  if [[ ! -f $helper ]]; then
    echo "missing $helper; run 'npm run build:helpers' before packing" >&2
    exit 1
  fi
  if [[ ! -x $helper ]]; then
    echo "$helper is not executable; the app's installer keeps its mode" >&2
    exit 1
  fi
  printf '  %s (%s)\n' "$helper" "$(du -h "$helper" | cut -f1)"
done

zip -q -r -X dist/lrclib-lyrics.zip "${common[@]}" bin -x '.*' '*/.*'
for platform in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64 windows-arm64 windows-amd64; do
  helper="bin/read-index-$platform"
  if [[ $platform == windows-* ]]; then helper="$helper.exe"; fi
  zip -q -r -X "dist/plugin-$platform.zip" "${common[@]}" "$helper" -x '.*' '*/.*'
done
echo "---"
ls -lh dist/
