#!/usr/bin/env bash
# Publish the zips as one release. The app only compares tags that begin with
# a lowercase v followed by numbers, and its release picker needs a .zip for
# each platform (or one for none). Check both before asking GitHub for a tag.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "JSON.parse(require('node:fs').readFileSync('plugin.json','utf8')).version")
tag="v$version"

if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "plugin.json version '$version' isn't a plain x.y.z; the app compares tags as numbers" >&2
  exit 1
fi

shopt -s nullglob
zips=(dist/*.zip)
if (( ${#zips[@]} == 0 )); then
  echo "no zips in dist/; run 'npm run pack' first" >&2
  exit 1
fi
for platform in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64 windows-arm64 windows-amd64; do
  if [[ ! -f dist/plugin-$platform.zip ]]; then
    echo "missing dist/plugin-$platform.zip; run 'npm run pack' first" >&2
    exit 1
  fi
done

if gh release view "$tag" >/dev/null 2>&1; then
  echo "release $tag already exists; bump plugin.json's version first" >&2
  exit 1
fi

exec gh release create "$tag" dist/*.zip --title "Lyrics for MyGo Music $version" --generate-notes
