# LRCLib Lyrics for MyGo Music

[简体中文](README_zh.md)

A MyGo Music plugin that brings time-synced lyrics from
[LRCLib](https://lrclib.net/) to your local music. It needs no account or API
key, uses the synced LRC when LRCLib has one and falls back to plain lines
when it doesn't, and caches every answer by track id.

## Lyrics source & thanks

All lyrics come from **[LRCLib](https://lrclib.net/)** — a free, community-run
database of synced lyrics with a public JSON API.

- **Open the site:** [https://lrclib.net/](https://lrclib.net/) → [LRCLib ↗](https://lrclib.net/)
- **API used by this plugin:** `GET https://lrclib.net/api/get` and
  `GET https://lrclib.net/api/search`
- No credentials, no scraping of web pages.

**Thanks to [LRCLib](https://lrclib.net/)** and to everyone who uploads and
corrects lyrics there. This plugin is an independent client of their public
API; it is not affiliated with or endorsed by LRCLib. Please respect their
[terms](https://lrclib.net/) and keep request volume modest — the background
sync is deliberately small for that reason.

## Why it also writes `.lrc` files

MyGo Music is plugin-driven: `loadLyrics` asks **the source of the playing
track** for lyrics, and the built-in **Local Files** source reads only a
`.lrc` beside the audio or timed tags inside it
(`internal/local/local.go`). It never asks another plugin. That is why this
plugin does two things:

1. It is a source of its own, so `lyrics({id})` works when you play from it.
2. It writes found synced lyrics as `.lrc` beside your songs, so they also
   show while you play from **Local Files** — the case that was missing.

## What it does

| Behaviour | Implementation |
| --- | --- |
| Primary lookup | `GET https://lrclib.net/api/get` with `artist_name`, `track_name`, `album_name` and `duration` |
| Identification | `User-Agent: LRCLibLyrics/<version> (…)`, `Accept: application/json` |
| `syncedLyrics` | returned as `lrc` (the app parses LRC itself) |
| `plainLyrics` | returned as timed `lines`, spread over the song (the app needs a time per line) |
| Caching | `host.storage` keyed by track id, with a TTL and a 24 h second look for short results |
| Output shape | the app's `music.Lyrics`: `{lrc, translation}` or `{lines}` |
| Attribution | plugin name in the sidebar, and a link to LRCLib in every setting |

Matching and reliability details:

- `plainLyrics` is guarded against `null` instead of being cast to a string.
- Short results (≤ 5 lines) are refreshed at most once a day.
- A 404 from `/api/get` — often caused by a compilation album name in the
  local index — is retried without `album_name`, then without `duration`, then
  with cleaned-up titles, and finally by `/api/search`. Every answer is scored
  against the song; a loose match is discarded rather than showing wrong words.
- A network error is **not** cached as a miss; the next play asks again.
- A brief failure reading the local index is retried in 5 seconds, instead of
  caching an empty library for a minute.
- A bilingual LRC (two lines sharing a timestamp) splits into `lrc` +
  `translation`.
- Found synced lyrics are written beside the audio as `.lrc`, never
  overwriting a file of your own.

## Default values (no blank boxes)

MyGo Music's `music.Setting` has only `key`, `label`, `help` and `link`: a
manifest cannot declare a default. The helper's `defaults` mode writes
`<app data>/plugin-data/lrclib-lyrics/settings.json` (only keys that are
absent, so your edits are kept), and `index.js` falls back to the same values
in memory when a box is blank:

| key | default |
| --- | --- |
| `library` | `<app data>/local/index.json` (absolute path) |
| `endpoint` | `https://lrclib.net` |
| `cacheHours` | `168` |
| `timeoutMs` | `8000` |
| `writeLrc` | `true` |
| `syncLimit` | `25` |
| `syncIntervalMinutes` | `15` |

There is no `artist`, `title` or `album` override: metadata comes from the
app's local library index. For a **local install**, `npm run install:local`
writes the file before the app starts and restores all defaults with `--force`.
For a **published install** the app's installer only copies files, so `account()`
(and `played()`) call the helper once the listener has allowed programs in
Settings > Plugins; a failed attempt is retried a minute later. The app reads
`settings.json` when it loads a plugin, so the boxes show these values from the
next start — functionality never waits for that, because blank boxes already
use the defaults above.

## Playing from Local Files

The app's Local Files source reads `<song base>.lrc` itself. There are two
ways lyrics get written there:

```bash
npm run sync:lrc              # 25 songs per run, direct and repeatable
npm run sync:lrc -- --all     # the whole library, one song at a time
npm run sync:lrc -- --limit 100 --pause 250
```

`sync-lrc.mjs` loads the plugin's own `index.js` with a stand-in host, so it
uses exactly the same lookup, scoring and `storage.json` cache as the app. It
skips songs that already have a `.lrc`. On a machine that needs a proxy:

```bash
HTTPS_PROXY=http://127.0.0.1:10808 NODE_USE_ENV_PROXY=1 npm run sync:lrc
```

Inside the app, `account()` and `played()` also start a bounded background
sync (25 songs, 15-minute interval, 8-second budget), writing `.lrc` files
through the helper. Because the app only calls `played()` on the source a
track belongs to, the CLI above is the dependable way to fill in **all** of a
Local Files library.

## Layout

```
plugin.json                  manifest: permissions, settings, navigation
index.js                     the whole plugin (one module, no build step)
locales/zh-CN.json           Simplified Chinese
cmd/read-index/main.go       helper: read index, write defaults, write .lrc
bin/read-index-<os>-<arch>   helper binaries (built, executable bit kept)
scripts/sync-lrc.mjs         offline sync CLI for Local Files
test/                        Node unit tests with a mock host + mock fetch
scripts/app_test.go.txt      Go test run inside the app's real JS runtime
scripts/verify-in-app.sh     runs that test against a mygo-music checkout
scripts/build-helpers.sh     cross-compiles the helper for all platforms
scripts/install-local.sh     installs plugin + default settings locally
scripts/pack.sh              zips it for installing / publishing
dist/                        the zips (gitignored)
```

The `bin/read-index-*` process permission is why the plugin can read the
app's `local/index.json` and write `.lrc` beside songs: a plugin has no
filesystem API. The helper only touches the files it is told about, and
computes the same `sha256("track\x00"+path)[:16]` ids as the app's local
source.

## Development environment

Requirements: Node ≥ 20, Go ≥ 1.27 (only for the helper and the app-runtime
test). No `npm install` — tests use Node's built-in runner.

```bash
npm run check          # syntax of index.js and sync-lrc.mjs
npm test               # 28 offline unit tests with a mock host / mock LRCLib
npm run go:test        # helper's Go tests (defaults, sidecars, filenames)
npm run build:helpers  # cross-compile bin/read-index-* (6 platforms)
npm run pack           # dist/*.zip, with executable bits preserved
npm run release        # publish v<version> with all the zip assets
npm run install:local  # copy into the app's plugins dir + write defaults
npm run verify:app     # load the plugin in MyGo Music's real JS runtime
```

`verify:app` needs a checkout of `egoist/mygo-music`; set `MYGO_MUSIC_SRC` or
let it clone into `.dev/mygo-music`. It copies `scripts/app_test.go.txt` into
`internal/plugin/` and runs `go test` there. The Go test uses a local mock
LRCLib server, a one-song local index and the real helper, so it is offline
and checks the actual `music.Lyrics` shapes the player consumes. Where Go
module downloads can't verify certificates, `.dev/goproxy` (a small `file://`
proxy cache) is used; ordinary networks need none of this.

## Installing it in the app

1. `npm run build:helpers` (once; the binaries are in `bin/`).
2. `npm run install:local`, or in **Settings > Plugins > +** choose this folder
   or `dist/lrclib-lyrics.zip`.
3. Start the app. In **Settings > Plugins**, allow *LRCLib Lyrics* to start its
   helper (`bin/read-index-*`). The app asks for this because a program can do
   anything the listener can; the helper here only reads `index.json`, writes
   defaults and writes `.lrc` beside songs that have none.
4. Either play from the **LRCLib Lyrics** sidebar source, or run
   `npm run sync:lrc` once and keep playing from **Local Files**.

## Publishing

Install button:
[![Install in MyGo Music](https://img.shields.io/badge/MyGo%20Music-Install-blue)](mygo-music://install-plugin?repo=AdkinsHan/mygo-local-lyrics)

As the [Publishing a plugin](https://github.com/egoist/mygo-music#publishing-a-plugin)
section says: put `plugin.json` at the top of a public GitHub repository. The
app takes the latest release's `.zip` asset named for a platform
(`plugin-darwin-arm64.zip`, …), one named for none, or the source; without a
release it takes the latest commit. A new tag or commit shows as an update.
Each platform zip now carries only that platform's helper; the general zip
carries all six.

```bash
npm run build:helpers   # bin/ is gitignored; a fresh clone has none
npm run pack            # refuses to make a zip without all six helpers
npm run release         # v1.1.1 with all seven zip assets
```

`npm run release` is a thin wrapper around `gh release create` which checks the
tag matches `plugin.json` and is **lowercase** `v`: the app compares tag
numbers only with a leading lowercase `v`, and an unparseable tag makes every
later tag look like an update.

The repository is public with the topic `mygo-music-plugin`, so it is listed on
the [plugins page](https://mygo-music.egoist.dev/plugins). The install link is
`mygo-music://install-plugin?repo=AdkinsHan/mygo-local-lyrics`.

The plugin needs App **0.1.8+**: `host.t()` and `locales/` translations arrived
in 0.1.8 (0.1.7 was when `process` permissions could name programs). Apps
before 0.1.8 ignore `minAppVersion`, so `index.js` falls back to English when
`host.t` is missing rather than failing. Installing from the source zipball
alone cannot work — `bin/` is gitignored — so a release with the zip assets is
required; this is why the command above publishes all seven.

`network` is `["lrclib.net"]` only. A custom endpoint on another host needs
that host added to the network permission.

## Limits

- The app does not ask a plugin for lyrics of a track belonging to another
  source. That is why `.lrc` files are written for Local Files.
- The background sync is deliberately small (25 songs / 15 min) because
  LRCLib is community-run; use `sync:lrc --all` for a full first pass.
- Translation only appears when LRCLib's LRC itself contains paired lines.
- LRCLib is a community database: coverage depends on what listeners
  uploaded, and an exact match by album/duration can still miss.

## License

AGPL-3.0, the same as MyGo Music; see [LICENSE](LICENSE). Lyrics are provided
by [LRCLib](https://lrclib.net/) and are used under its own terms.
