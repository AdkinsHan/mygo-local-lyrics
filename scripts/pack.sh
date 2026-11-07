#!/usr/bin/env bash
# Make zips the app can install. The general zip carries every platform's
# helper; the platform-named release assets carry just the one they need.
# Executable bits on the helpers are kept, as the app's installer reads them.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p dist
rm -f dist/*.zip
common=(plugin.json index.js locales)

zip -q -r -X dist/lrclib-lyrics.zip "${common[@]}" bin -x '.*' '*/.*'
for platform in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64 windows-arm64 windows-amd64; do
  helper="bin/read-index-$platform"
  if [[ $platform == windows-* ]]; then helper="$helper.exe"; fi
  zip -q -r -X "dist/plugin-$platform.zip" "${common[@]}" "$helper" -x '.*' '*/.*'
done
echo "---"
ls -lh dist/
