#!/usr/bin/env bash
# Install the plugin into the app's plugins directory for development, and
# write the plugin's default settings into its data directory at the same time.
# The host's Setting has no default field, so this is what keeps the Settings >
# Plugins boxes from being empty on first install.
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(uname -s)" in
  Darwin) appData="$HOME/Library/Application Support/MyGo Music" ;;
  Linux)  appData="${XDG_DATA_HOME:-$HOME/.local/share}/MyGo Music" ;;
  MINGW*|MSYS*|CYGWIN*) appData="$APPDATA/MyGo Music" ;;
  *) echo "unknown platform; copy this folder into the app's plugins dir by hand" >&2; exit 1 ;;
esac

target="$appData/plugins/lrclib-lyrics"
data="$appData/plugin-data/lrclib-lyrics"
mkdir -p "$target" "$data"
cp plugin.json index.js "$target/"
mkdir -p "$target/locales" "$target/bin"
cp locales/*.json "$target/locales/"
cp bin/read-index-* "$target/bin/"
chmod 755 "$target"/bin/read-index-*

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) helper="bin/read-index-windows-amd64.exe" ;;
  *)
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)
    case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; esac
    helper="bin/read-index-$os-$arch"
    ;;
esac
if [ ! -x "$helper" ]; then
  echo "missing helper $helper; run npm run build:helpers first" >&2
  exit 1
fi

# --force is for this development install: it restores every default, so an
# earlier blank settings.json is replaced as well. A published install keeps
# whatever the listener has already set.
"$helper" defaults "$data" "$appData/local/index.json" --force
echo "defaults: $(cat "$data/settings.json")"

echo "installed to $target"
echo
echo "Next: start MyGo Music, then in Settings > Plugins allow 'LRCLib Lyrics'"
echo "to start its helper. Found lyrics are written as .lrc beside your songs,"
echo "so they also show while you play from Local Files."
