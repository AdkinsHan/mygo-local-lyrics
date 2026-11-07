# verify-in-app.sh runs the plugin inside MyGo Music's real JavaScript runtime
# (moejs), the way the app does: plugin.Load -> Can -> Lyrics/Home/Search/Stream.
# It needs a checkout of egoist/mygo-music; set MYGO_MUSIC_SRC to its path or
# let the script clone it into .dev/mygo-music (a git clone, not a dependency).
#
# Network calls to LRCLib go through the app's fetch. Where this machine needs
# a proxy, HTTPS_PROXY is passed through. The Go module cache is warmed from a
# local file:// proxy when the network can't verify certificates.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=${MYGO_MUSIC_SRC:-.dev/mygo-music}
if [ ! -d "$SRC/.git" ]; then
  echo "cloning egoist/mygo-music into $SRC" >&2
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 https://github.com/egoist/mygo-music.git "$SRC"
fi

# The test file lives in the app's internal/plugin package so it can use Load.
cp scripts/app_test.go.txt "$SRC/internal/plugin/lyrics_verify_test.go"
cp scripts/zip_test.go.txt "$SRC/internal/plugin/lyrics_zip_test.go"
trap 'rm -f "$SRC/internal/plugin/lyrics_verify_test.go" "$SRC/internal/plugin/lyrics_zip_test.go"' EXIT

export LYRICS_PLUGIN_DIR="$PWD"
if [ -f dist/lrclib-lyrics.zip ]; then export LYRICS_PLUGIN_ZIP="$PWD/dist/lrclib-lyrics.zip"; fi
cd "$SRC"
GOPROXY=${GOPROXY:-file://$LYRICS_PLUGIN_DIR/.dev/goproxy,https://goproxy.cn,direct} \
GOSUMDB=${GOSUMDB:-off} \
  go test ./internal/plugin/ -run TestLyricsPlugin -count=1 -v
