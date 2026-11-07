import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, trackRow, syncedLRC, plainLyrics } from "./harness.mjs";

const getHit = {
  match: (u) => u.includes("/api/get"),
  json: { trackName: "Creep", artistName: "Radiohead", albumName: "Pablo Honey", duration: 239, syncedLyrics: syncedLRC, plainLyrics: plainLyrics },
};

test("lyrics() asks /api/get with artist, title, album and whole seconds", async () => {
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit] });
  const got = await p.lyrics({ id: "id1" });

  assert.equal(got.lrc, syncedLRC);
  assert.equal(p.calls.fetch.length, 1, "an exact hit needs one request");
  const u = new URL(p.calls.fetch[0].url);
  assert.equal(u.host, "lrclib.net");
  assert.equal(u.pathname, "/api/get");
  assert.equal(u.searchParams.get("artist_name"), "Radiohead");
  assert.equal(u.searchParams.get("track_name"), "Creep");
  assert.equal(u.searchParams.get("album_name"), "Pablo Honey");
  assert.equal(u.searchParams.get("duration"), "238");
  const headers = p.calls.fetch[0].init.headers;
  assert.match(headers["User-Agent"], /^LRCLibLyrics\//);
  assert.equal(headers.Accept, "application/json");
});

test("a wrong album in the local index falls back to /api/get without it", async () => {
  const p = await loadPlugin({
    index: [trackRow({ album: "Billboard Hot 100" })],
    responses: [{
      match: (u) => u.includes("/api/get") && !u.includes("album_name="),
      json: { trackName: "Creep", artistName: "Radiohead", duration: 238, syncedLyrics: syncedLRC },
    }],
  });
  const got = await p.lyrics({ id: "id1" });
  assert.equal(got.lrc, syncedLRC);
  assert.equal(p.calls.fetch.length, 2, "it tried the strict query, then the relaxed one");
  const urls = p.calls.fetch.map((x) => new URL(x.url));
  assert.ok(urls[0].searchParams.get("album_name"), "the first request keeps the real album");
  assert.equal(urls.at(-1).searchParams.has("album_name"), false);
});

test("a second-chance title still has to be the same song", async () => {
  const p = await loadPlugin({
    index: [trackRow({ title: "Creep (Remastered)" })],
    responses: [{
      match: (u) => u.includes("/api/get"),
      json: { trackName: "Creeping Death", artistName: "Metallica", syncedLyrics: "[00:01.00] Wrong words" },
    }],
  });
  assert.deepEqual(await p.lyrics({ id: "id1" }), { lrc: "" });
  assert.ok(p.calls.fetch.length > 1, "it did try alternative titles");
});

test("lyrics() uses plainLyrics as timed lines when syncedLyrics is missing", async () => {
  const p = await loadPlugin({
    index: [trackRow({ duration: 60000 })],
    responses: [{ match: (u) => u.includes("/api/get"), json: { syncedLyrics: "", plainLyrics } }],
  });
  const got = await p.lyrics({ id: "id1" });

  assert.equal(got.lrc, undefined);
  assert.equal(got.lines.length, 6);
  assert.equal(got.lines[0].text, "When you were here before");
  assert.ok(got.lines.every((l) => l.start >= 0 && l.end > l.start));
  for (let i = 1; i < got.lines.length; i++) {
    assert.ok(got.lines[i].start >= got.lines[i - 1].end - 1, "lines follow one another");
  }
});

test("a null plainLyrics is not cast to a string", async () => {
  const p = await loadPlugin({
    index: [trackRow()],
    responses: [{ match: (u) => u.includes("/api/get"), json: { syncedLyrics: null, plainLyrics: null } }],
  });
  assert.deepEqual(await p.lyrics({ id: "id1" }), { lrc: "" });
});

test("a 404 on /api/get falls back to /api/search and scores the candidates", async () => {
  const responses = [
    {
      match: (u) => u.includes("/api/search"),
      json: [
        {
          trackName: "Creep (Acoustic)",
          artistName: "Someone Else",
          albumName: "Live",
          duration: 400,
          syncedLyrics: "[00:01.00] Wrong song",
        },
        {
          trackName: "Creep",
          artistName: "Radiohead",
          albumName: "Pablo Honey",
          duration: 239,
          syncedLyrics: "[00:19.16] When you were here before",
        },
      ],
    },
  ];
  const p = await loadPlugin({ index: [trackRow()], responses });
  const got = await p.lyrics({ id: "id1" });
  assert.match(got.lrc, /When you were here before/);
  assert.ok(p.calls.fetch.some((x) => x.url.includes("/api/get")), "an exact lookup is tried first");
  assert.match(p.calls.fetch.find((x) => x.url.includes("/api/search")).url, /q=Creep(\+|%20)Radiohead/);
});

test("a loose /api/search match is rejected rather than showing wrong words", async () => {
  const p = await loadPlugin({
    index: [trackRow()],
    responses: [
      {
        match: (u) => u.includes("/api/search"),
        json: [
          {
            trackName: "Creeping Death",
            artistName: "Metallica",
            albumName: "Ride the Lightning",
            duration: 400,
            syncedLyrics: "[00:01.00] Wrong words entirely",
          },
        ],
      },
    ],
  });
  assert.deepEqual(await p.lyrics({ id: "id1" }), { lrc: "" });
});

test("a network failure is not cached as a miss, and is retried next play", async () => {
  const p = await loadPlugin({
    index: [trackRow()],
    responses: [{ match: () => true, error: "TLS certificate failed" }],
  });
  assert.deepEqual(await p.lyrics({ id: "id1" }), { lrc: "" });
  assert.equal(p.storage["lyrics:v1:id1"], undefined, "network errors are not misses");
  await p.lyrics({ id: "id1" });
  assert.ok(p.calls.fetch.length > 2, "the next play asks again");
});

test("a bilingual LRC splits into lrc + translation, an ordinary one does not", async () => {
  const bilingual = [
    "[00:01.00] Hello",
    "[00:01.00] 你好",
    "[00:04.00] World",
    "[00:04.00] 世界",
    "[00:07.00] Again",
    "[00:07.00] 再来",
  ].join("\n");
  const p = await loadPlugin({
    index: [trackRow()],
    responses: [{ match: (u) => u.includes("/api/get"), json: { syncedLyrics: bilingual } }],
  });
  const got = await p.lyrics({ id: "id1" });
  assert.equal(got.lrc.split("\n").length, 3);
  assert.equal(got.translation.split("\n").length, 3);
  assert.match(got.lrc, /\[00:01\.00\] Hello/);
  assert.match(got.translation, /\[00:01\.00\] 你好/);

  const q = await loadPlugin({
    index: [trackRow()],
    responses: [{ match: (u) => u.includes("/api/get"), json: { syncedLyrics: syncedLRC } }],
  });
  const plain = await q.lyrics({ id: "id1" });
  assert.equal(plain.translation, undefined);
  assert.equal(plain.lrc, syncedLRC);
});

test("cache is keyed by id and is reused until it expires", async () => {
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit] });
  await p.lyrics({ id: "id1" });
  const second = await p.lyrics({ id: "id1" });
  assert.equal(second.lrc, syncedLRC);
  assert.equal(p.calls.fetch.length, 1, "a cache hit makes no second request");
  assert.ok(p.storage["lyrics:v1:id1"]);

  const stale = await loadPlugin({
    index: [trackRow()],
    responses: [getHit],
    storage: { "lyrics:v1:id1": { at: Date.now() - 200 * 3600 * 1000, lrc: "[00:01.00] old" } },
  });
  assert.equal((await stale.lyrics({ id: "id1" })).lrc, syncedLRC);
  assert.equal(stale.calls.fetch.length, 1, "an expired cache is refreshed");
});

test("cacheHours=0 disables caching; a checked miss is cached for an hour", async () => {
  const off = await loadPlugin({ index: [trackRow()], responses: [getHit], settings: { cacheHours: "0" } });
  await off.lyrics({ id: "id1" });
  await off.lyrics({ id: "id1" });
  assert.equal(off.calls.fetch.length, 2);
  assert.equal(off.storage["lyrics:v1:id1"], undefined);

  const miss = await loadPlugin({
    index: [trackRow()],
    settings: { cacheHours: "24" },
  });
  await miss.lyrics({ id: "id1" });
  const once = miss.calls.fetch.length;
  await miss.lyrics({ id: "id1" });
  assert.equal(miss.calls.fetch.length, once, "a checked miss isn't looked up again");
  assert.equal(miss.storage["lyrics:v1:id1"].miss, true);
  assert.equal(miss.storage["lyrics:v1:id1"].checked, true);
});

test("an old unchecked miss from a network error is looked up again", async () => {
  const p = await loadPlugin({
    index: [trackRow()],
    responses: [getHit],
    storage: { "lyrics:v1:id1": { at: Date.now(), miss: true } },
  });
  assert.equal((await p.lyrics({ id: "id1" })).lrc, syncedLRC);
});

test("titles are washed without losing real suffixes", async () => {
  const p = await loadPlugin({
    index: [trackRow({ title: '76. "Slut!" (Taylor\'s Version) (From The Vault)', artist: "Taylor Swift / feat. Someone" })],
    responses: [getHit],
  });
  await p.lyrics({ id: "id1" });
  const u = new URL(p.calls.fetch[0].url);
  assert.equal(u.searchParams.get("track_name"), '"Slut!" (Taylor\'s Version) (From The Vault)');
  assert.equal(u.searchParams.get("artist_name"), "Taylor Swift");
});

test("only the first artist is sent to /api/get", async () => {
  const p = await loadPlugin({
    index: [trackRow({ artist: "A / B / C" })],
    responses: [getHit],
  });
  await p.lyrics({ id: "id1" });
  assert.equal(new URL(p.calls.fetch[0].url).searchParams.get("artist_name"), "A");
});

test("a failing helper leaves the plugin empty instead of crashing the app", async () => {
  const p = await loadPlugin({ index: [], spawnError: "the listener hasn't allowed programs" });
  const home = await p.home();
  assert.equal(home.sections[0].tracks.length, 0);
  assert.match(home.sections[0].empty, /Settings > Plugins/);
  assert.deepEqual(await p.lyrics({ id: "id1" }), { lrc: "" });
});

test("a brief helper failure is retried, not cached as an empty library", async () => {
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit], catalogFails: 1 });
  assert.deepEqual(await p.lyrics({ id: "id1" }), { lrc: "" });
  assert.equal((await p.lyrics({ id: "id1" })).lrc, syncedLRC);
  assert.equal(p.calls.spawn.filter((x) => x.args[0] !== "sync").length, 2);
});

test("unknown ids return no lyrics, without manual metadata overrides", async () => {
  const p = await loadPlugin({ index: [], responses: [getHit] });
  assert.deepEqual(await p.lyrics({ id: "unknown" }), { lrc: "" });
  assert.equal(p.calls.fetch.length, 0, "a track not in the library isn't guessed at");
});

test("the source answers home/browse/search/album/artist/stream for its own ids", async () => {
  const rows = [
    trackRow(),
    trackRow({ id: "id2", path: "/Music/Radiohead - Karma Police.mp3", title: "Karma Police", album: "OK Computer" }),
    trackRow({ id: "id3", path: "/Music/Miles Davis - So What.mp3", title: "So What", artist: "Miles Davis", album: "Kind of Blue" }),
  ];
  const p = await loadPlugin({ index: rows, responses: [getHit] });

  const home = await p.home();
  assert.equal(home.sections[0].tracks.length, 3);
  assert.match(home.description, /\.lrc/);
  assert.deepEqual(
    home.sections[0].tracks.map((t) => t.name).sort(),
    ["Creep", "Karma Police", "So What"],
  );

  const found = await p.search({ query: "Karma", kind: "tracks", offset: 0 });
  assert.equal(found.tracks.length, 1);
  assert.equal(found.tracks[0].id, "id2");

  const albums = await p.browse({ page: "albums" });
  assert.equal(albums.sections[0].albums.length, 3);
  const al = await p.album({ id: "al:OK Computer" });
  assert.equal(al.tracks[0].name, "Karma Police");
  const ar = await p.artist({ id: "a:Radiohead" });
  assert.equal(ar.tracks.length, 2);

  const stream = await p.stream({ id: "id1" });
  assert.equal(stream.type, "mp3");
  assert.equal(decodeURIComponent(stream.url), "file:///Music/Radiohead - Creep.mp3");
  await assert.rejects(p.stream({ id: "nope" }), (e) => e.code === "unavailable");
});

test("fileURL escapes the characters a file path may carry", async () => {
  const p = await loadPlugin({
    index: [trackRow({ path: "/Music/a#b?c 100%.mp3" })],
    responses: [getHit],
  });
  const stream = await p.stream({ id: "id1" });
  assert.equal(stream.url, "file:///Music/a%23b%3Fc%20100%25.mp3");
  assert.equal(decodeURIComponent(stream.url), "file:///Music/a#b?c 100%.mp3");
});

test("a custom endpoint keeps its path prefix and query parameters", async () => {
  const p = await loadPlugin({
    index: [trackRow()],
    responses: [getHit],
    settings: { endpoint: "https://lrc.example.com/lrclib?key=abc" },
  });
  await p.lyrics({ id: "id1" });
  const u = new URL(p.calls.fetch[0].url);
  assert.equal(u.host, "lrc.example.com");
  assert.equal(u.pathname, "/lrclib/api/get");
  assert.equal(u.searchParams.get("key"), null, "the endpoint's own query is dropped");
});

test("changing the library or endpoint setting drops the cached catalog", async () => {
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit] });
  await p.home();
  assert.equal(p.calls.spawn.length, 1, "the index is read once");
  await p.home();
  assert.equal(p.calls.spawn.length, 1, "a second page reuses it");
  await p.setSetting({ key: "library", value: "/tmp/other.json" });
  await p.home();
  assert.equal(p.calls.spawn.length, 2, "a new index path is read again");
});

test("account() starts a bounded sync that writes .lrc beside local songs", async () => {
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit] });
  const account = await p.account();
  assert.equal(account.id, "local");
  // account() doesn't hold the app's call up while it looks up the library.
  for (let i = 0; i < 20 && !p.calls.sync.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(p.calls.sync, [{ path: "/Music/Radiohead - Creep.mp3", lrc: syncedLRC }]);
  assert.ok(p.storage["lyrics:v1:id1"].lrc, "the background lookup is cached");
});

test("writeLrc=false stops writing files beside songs", async () => {
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit], settings: { writeLrc: "false" } });
  await p.account();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(p.calls.sync, []);
});

test("the manifest has only the settings the listener needs", async () => {
  const fs = await import("node:fs/promises");
  const manifest = JSON.parse(await fs.readFile("plugin.json", "utf8"));
  for (const key of ["artist", "title", "album"]) {
    assert.equal(manifest.settings.some((s) => s.key === key), false, `${key} override is still exposed`);
  }
  const p = await loadPlugin({ index: [trackRow()], responses: [getHit] });
  await p.lyrics({ id: "id1" });
  const u = new URL(p.calls.fetch[0].url);
  assert.equal(u.host, "lrclib.net", "the endpoint falls back to a real value");
  assert.match(p.calls.fetch[0].init.headers["User-Agent"], /^LRCLibLyrics\//);
  assert.ok(p.storage["lyrics:v1:id1"], "cacheHours falls back to a real value");
  for (const s of manifest.settings) {
    assert.match(s.help, /default/i, `${s.key}'s help doesn't say its default`);
  }
});
