// LRCLib Lyrics for MyGo Music.
//
// Lyrics come from LRCLib (https://lrclib.net/): one public JSON provider,
// no credentials, synced lyrics when it has them and plain lyrics when it
// doesn't, cached by track id. Everything is an `export function` in this one
// file: the runtime compiles `main` on its own.
//
// MyGo Music asks a source for lyrics with `lyrics({ id })` and nothing else,
// and only asks the source the playing track belongs to. Built-in Local Files
// reads a .lrc beside the song by itself, so found lyrics are also written
// beside the file by our helper: that is what makes them show while the
// listener plays from Local Files, where the app never asks this plugin.

const VERSION = "1.1.0";
const DEFAULT_ENDPOINT = "https://lrclib.net";
const USER_AGENT = `LRCLibLyrics/${VERSION} (https://github.com/egoist/mygo-music)`;

// Every setting has a real value, not an empty box. The installer and the
// `defaults` helper mode also put these into the app's settings.json, so the
// Settings > Plugins page shows them rather than blank fields.
const DEFAULT_SETTINGS = {
  endpoint: DEFAULT_ENDPOINT,
  library: "", // blank means the app's own local/index.json
  cacheHours: "168",
  timeoutMs: "8000",
  writeLrc: "true",
  syncLimit: "25",
  syncIntervalMinutes: "15",
};

const CACHE_PREFIX = "lyrics:v1:";
const DEFAULT_CACHE_HOURS = 168;
const DEFAULT_TIMEOUT_MS = 8000;
const CATALOG_TTL_MS = 60 * 1000;
const CATALOG_RETRY_MS = 5 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const SHORT_LYRIC_LINES = 5; // <= 5 lines may be an incomplete LRCLib upload
const SHORT_RECHECK_MS = 24 * 60 * 60 * 1000;
const SEARCH_PAGE_SIZE = 100;
const SYNC_BUDGET_MS = 8000; // never hold an app call longer than callTimeout
const SYNC_PAUSE_MS = 120; // be kind to a public, volunteer-run API

const t = (text) => host.t(text);

let catalog = null; // { list, byID: Map }
let catalogAt = 0;
let catalogPromise = null;
let catalogError = "";

let syncRunning = false;
let lastSyncAt = 0;

// ---------------------------------------------------------------------------
// Settings and small helpers
// ---------------------------------------------------------------------------

function rawSetting(key) {
  return (host.setting(key) || "").trim();
}

function textSetting(key) {
  return rawSetting(key) || DEFAULT_SETTINGS[key] || "";
}

function numberSetting(key, fallback, min, max) {
  const raw = textSetting(key);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function boolSetting(key) {
  const v = textSetting(key).toLowerCase();
  return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}

function endpoint() {
  return textSetting("endpoint");
}

function apiURL(path) {
  const u = new URL(endpoint());
  const prefix = u.pathname.replace(/\/+$/, "");
  u.pathname = prefix + path;
  u.search = "";
  u.hash = "";
  return u;
}

function separator() {
  return host.platform === "windows" ? "\\" : "/";
}

function libraryPath() {
  const custom = rawSetting("library");
  if (custom) return custom;
  const s = separator();
  // host.dataDir is <app data>/plugin-data/<id>; the built-in local source
  // keeps its index at <app data>/local/index.json.
  return [host.dataDir, "..", "..", "local", "index.json"].join(s);
}

function helperPath() {
  const name = `read-index-${host.platform}-${host.arch}`;
  return host.platform === "windows" ? `bin/${name}.exe` : `bin/${name}`;
}

function fileURL(path) {
  let s = String(path || "").replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s; // C:/Music on Windows
  return (
    "file://" +
    encodeURI(s)
      .replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
      .replace(/#/g, "%23")
      .replace(/\?/g, "%3F")
  );
}

function baseName(path) {
  const s = String(path || "").replace(/\\/g, "/");
  return s.slice(s.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
}

function audioType(path) {
  const ext = String(path || "").toLowerCase().split(".").pop();
  if (ext === "flac") return "flac";
  if (ext === "ogg" || ext === "oga") return "ogg";
  if (ext === "wav") return "wav";
  if (ext === "m4a") return "m4a";
  if (ext === "aac") return "aac";
  return "mp3";
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function normalize(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// cleanTitle drops track numbers and promotional noise, but keeps real
// suffixes such as
// "(Taylor's Version)", which LRCLib needs to tell versions apart.
function cleanTitle(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, ""); // "76.マリーゴールド"
  s = s.replace(/\s*\[[^\]]*(?:official|video|audio|lyrics?|mv|live|remix)[^\]]*\]/gi, "");
  s = s.replace(/\s*[-–]\s*(?:feat\.?|ft\.?|featuring)\s+.*$/i, "");
  return s.replace(/\s+/g, " ").trim();
}

// alternateTitles are second chances for /api/get: an album name in the local
// index often differs from the one LRCLib knows, and a "(Remastered)" suffix
// is often missing there. The first attempt always uses the real title.
function alternateTitles(title) {
  const out = [];
  const add = (s) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    if (s && s !== title && !out.includes(s)) out.push(s);
  };
  add(
    String(title)
      .replace(/\s*\([^)]*\)/g, " ")
      .replace(/\s*\[[^\]]*\]/g, " ")
      .replace(/\s*[-–]\s*(?:live|remix|remaster(?:ed)?|instrumental|acoustic|radio\s+edit)\b.*$/i, ""),
  );
  add(String(title).replace(/\s*(?:\(|\[)?\s*(?:feat\.?|ft\.?|featuring)\s+.*$/i, ""));
  return out.slice(0, 2);
}

function splitArtists(raw) {
  return String(raw || "")
    .split(/\s\/\s|;|、|\sfeat\.\s|\sft\.\s/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function primaryArtist(raw) {
  const names = splitArtists(raw);
  return names.length ? names[0] : "";
}

function toTrack(row) {
  const name = row.title || baseName(row.path);
  const album = row.album || "";
  const artists = splitArtists(row.artist).map((n) => ({ id: "a:" + n, name: n }));
  const art = {
    id: "al:" + album,
    name: album,
    imageUrl: row.cover ? fileURL(row.cover) : "",
  };
  return {
    id: row.id,
    name,
    artists,
    album: art,
    duration: Number(row.duration) || 0,
  };
}

function withTimeout(promise, ms, fallback) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The local library index, through bin/read-index-<platform>-<arch>
// ---------------------------------------------------------------------------

async function readIndex() {
  const p = host.spawn(helperPath(), [libraryPath()]);
  let text = "";
  for (;;) {
    const line = await withTimeout(p.readLine(), 15000, null);
    if (line === null || line === undefined) break;
    text += line;
  }
  const code = await withTimeout(p.wait(), 5000, -1);
  if (code !== 0) {
    let why = "";
    try {
      why = p.errorOutput();
    } catch (e) {
      /* the runtime may have dropped the program */
    }
    throw new Error(why || `read-index exited ${code}`);
  }
  if (!text.trim()) return [];
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("read-index did not answer a list");
  return rows;
}

async function ensureCatalog() {
  // A failed read must not cache an empty library for a minute: that is how a
  // song played during a brief helper failure gets no lyrics at all.
  if (catalog && catalog.byID.size > 0 && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    let rows = [];
    catalogError = "";
    try {
      rows = await readIndex();
    } catch (e) {
      catalogError = String((e && e.message) || e);
      console.warn("local index:", catalogError);
      catalogAt = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
      if (catalog && catalog.byID.size > 0) {
        catalogPromise = null;
        return catalog; // keep the last good library
      }
      catalog = { list: [], byID: new Map() };
      catalogPromise = null;
      return catalog;
    }
    const byID = new Map();
    for (const row of rows) {
      if (!row || !row.path) continue;
      byID.set(String(row.id), row);
    }
    const list = rows.slice().sort((a, b) =>
      String(a.title || baseName(a.path)).localeCompare(String(b.title || baseName(b.path))),
    );
    catalog = { list, byID };
    catalogAt = Date.now();
    catalogPromise = null;
    return catalog;
  })();
  return catalogPromise;
}

function emptyHint() {
  return catalogError
    ? t("Allow this plugin's helper in Settings > Plugins to read your local library.")
    : t("No local songs were found.");
}

// ---------------------------------------------------------------------------
// LRCLib: several chances at /api/get, then /api/search as a fallback
// ---------------------------------------------------------------------------

// A request answers ok, miss (a real 404/400) or error (no answer at all).
// Only a real miss may be cached; a TLS failure or a timeout must be tried
// again on the next play, not remembered as "this song has no lyrics".
async function requestJSON(url, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch (e) {
        /* the request may already be done */
      }
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  const work = (async () => {
    const res = await fetch(String(url), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 404 || res.status === 400) return { status: "miss", json: null };
    if (!res.ok) throw new Error(`LRCLib answered ${res.status}`);
    return { status: "ok", json: await res.json() };
  })();
  try {
    return await Promise.race([work, guard]);
  } catch (e) {
    console.warn("lrclib:", String((e && e.message) || e), String(url));
    return { status: "error", json: null };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// plainToLines spreads untimed words across the song. MyGo Music needs a time
// for every line; an all-zero timeline would make the whole lyric show at once.
function plainToLines(plain, durationMs) {
  const rows = String(plain)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!rows.length) return [];
  const total = Math.max(Number(durationMs) || 0, rows.length * 4000);
  const span = Math.max(total - 500, rows.length * 1000);
  const step = Math.max(500, Math.floor(span / rows.length));
  return rows.map((text, i) => ({ start: i * step, end: (i + 1) * step, text }));
}

// splitTranslation turns a bilingual LRC (two lines sharing a timestamp) into
// the app's `lrc` + `translation` pair. Only when there really are pairs: an
// ordinary LRC with a repeated timestamp for a chorus must stay untouched.
const LRC_TIME = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function splitTranslation(lrc) {
  const byTime = new Map();
  for (const raw of String(lrc).split(/\r?\n/)) {
    LRC_TIME.lastIndex = 0;
    let match = null;
    let last = 0;
    const stamps = [];
    while ((match = LRC_TIME.exec(raw)) !== null) {
      const frac = match[3] || "";
      const ms =
        (Number(match[1]) * 60 + Number(match[2])) * 1000 +
        (frac ? Number(frac) * Math.pow(10, 3 - frac.length) : 0);
      stamps.push(ms);
      last = LRC_TIME.lastIndex;
    }
    if (!stamps.length) continue;
    const text = raw.slice(last).trim();
    if (!text) continue;
    for (const ms of stamps) {
      if (!byTime.has(ms)) byTime.set(ms, []);
      const list = byTime.get(ms);
      if (!list.includes(text)) list.push(text);
    }
  }
  let pairs = 0;
  for (const list of byTime.values()) {
    if (list.length > 1) pairs++;
  }
  if (pairs < 3) return { lrc, translation: "" };

  const times = Array.from(byTime.keys()).sort((a, b) => a - b);
  const stamp = (ms) => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}]`;
  };
  const main = [];
  const translation = [];
  for (const ms of times) {
    const list = byTime.get(ms);
    main.push(`${stamp(ms)} ${list[0]}`);
    if (list.length > 1) translation.push(`${stamp(ms)} ${list[1]}`);
  }
  return { lrc: main.join("\n"), translation: translation.join("\n") };
}

function pickLyrics(json, durationMs) {
  if (!json || typeof json !== "object" || json.instrumental === true) return null;
  const synced = typeof json.syncedLyrics === "string" ? json.syncedLyrics.trim() : "";
  const plain = typeof json.plainLyrics === "string" ? json.plainLyrics.trim() : "";
  if (synced) {
    const split = splitTranslation(synced);
    return { lrc: split.lrc, translation: split.translation, kind: "synced" };
  }
  // A null plainLyrics must not be cast to a string.
  if (plain) return { lines: plainToLines(plain, durationMs), kind: "plain" };
  return null;
}

function metadata(row) {
  return {
    title: cleanTitle(row.title || baseName(row.path)),
    artist: primaryArtist(row.artist),
    artists: splitArtists(row.artist),
    album: row.album || "",
    duration: Number(row.duration) || 0,
  };
}

async function exactMatch(meta, timeoutMs, deadline) {
  // /api/get answers 400 for an empty artist, so don't send one.
  if (!meta.artist || !meta.title) return { hit: null, failed: false };
  const alts = alternateTitles(meta.title);
  const attempts = [{ title: meta.title, album: meta.album, duration: meta.duration }];
  // The local index's album name is often a compilation ("Billboard Hot 100")
  // while LRCLib knows the original album. Dropping it is the single biggest
  // improvement to the hit rate for local files.
  if (meta.album) attempts.push({ title: meta.title, album: "", duration: meta.duration });
  attempts.push({ title: meta.title, album: "", duration: 0 });
  for (const alt of alts) attempts.push({ title: alt, album: "", duration: 0 });

  const seen = new Set();
  let failed = false;
  for (const a of attempts) {
    const sig = [meta.artist, a.title, a.album, a.duration].join("\u0000");
    if (seen.has(sig)) continue;
    seen.add(sig);
    if (deadline && Date.now() > deadline) break;
    const u = apiURL("/api/get");
    u.searchParams.set("artist_name", meta.artist);
    u.searchParams.set("track_name", a.title);
    if (a.album) u.searchParams.set("album_name", a.album);
    if (a.duration > 0) u.searchParams.set("duration", String(Math.round(a.duration / 1000)));
    const r = await requestJSON(u, timeoutMs);
    if (r.status === "error") {
      failed = true;
      break;
    }
    if (r.status === "ok") {
      const hit = pickLyrics(r.json, meta.duration);
      // A second-chance title (without its suffix, say) must still be the
      // same song. LRCLib can answer a near title with another recording.
      if (hit && scoreCandidate({
        title: r.json.trackName || r.json.name || a.title,
        artist: r.json.artistName || meta.artist,
        album: r.json.albumName || "",
        duration: Number(r.json.duration) || 0,
        synced: Boolean(hit.lrc),
      }, meta) >= 45) return { hit, failed: false };
    }
  }
  return { hit: null, failed };
}

function scoreCandidate(cand, meta) {
  const wantedTitle = normalize(cleanTitle(meta.title));
  const gotTitle = normalize(cleanTitle(cand.title));
  if (!wantedTitle || !gotTitle) return 0;
  let score = 0;
  if (gotTitle === wantedTitle) score += 45;
  else if (gotTitle.includes(wantedTitle) || wantedTitle.includes(gotTitle)) score += 30;
  else {
    const a = new Set(wantedTitle.split(" ").filter(Boolean));
    const b = gotTitle.split(" ").filter(Boolean);
    const shared = b.filter((w) => a.has(w)).length;
    if (!shared) return 0;
    score += Math.round((20 * shared) / Math.max(a.size, 1));
  }

  const wantedArtist = normalize(meta.artist);
  const gotArtist = normalize(cand.artist);
  if (wantedArtist && gotArtist) {
    if (gotArtist === wantedArtist) score += 25;
    else if (gotArtist.includes(wantedArtist) || wantedArtist.includes(gotArtist)) score += 18;
    else {
      const names = meta.artists.map(normalize);
      if (names.some((n) => n && (gotArtist.includes(n) || n.includes(gotArtist)))) score += 10;
      else score -= 8;
    }
  }

  const wantedAlbum = normalize(meta.album);
  const gotAlbum = normalize(cand.album);
  if (wantedAlbum && gotAlbum && (gotAlbum === wantedAlbum || gotAlbum.includes(wantedAlbum))) {
    score += 8;
  }
  if (meta.duration > 0 && cand.duration > 0) {
    const diff = Math.abs(cand.duration - meta.duration / 1000);
    if (diff <= 2) score += 12;
    else if (diff <= 5) score += 6;
    else if (diff > 20) score -= 6;
  }
  if (cand.synced) score += 10;
  return score;
}

async function searchFallback(meta, timeoutMs, deadline) {
  if (!meta.title) return { hit: null, failed: false };
  const alts = alternateTitles(meta.title);
  const urls = [];
  const add = (params) => {
    const u = apiURL("/api/search");
    for (const key of Object.keys(params)) {
      const v = String(params[key] || "").trim();
      if (v) u.searchParams.set(key, v);
    }
    const s = String(u);
    if (!urls.some((x) => String(x) === s)) urls.push(u);
  };
  add({ q: `${meta.title} ${meta.artist}`.trim() });
  add({ q: meta.title });
  if (meta.artist) add({ track_name: meta.title, artist_name: meta.artist });
  for (const alt of alts) add({ track_name: alt, artist_name: meta.artist });

  let best = null;
  let bestScore = 0;
  let failed = false;
  for (const u of urls) {
    if (deadline && Date.now() > deadline) break;
    const r = await requestJSON(u, timeoutMs);
    if (r.status === "error") {
      failed = true;
      continue;
    }
    if (r.status !== "ok" || !Array.isArray(r.json)) continue;
    for (const item of r.json.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      const picked = pickLyrics(item, meta.duration);
      if (!picked) continue;
      const score = scoreCandidate(
        {
          title: item.trackName || item.name || "",
          artist: item.artistName || "",
          album: item.albumName || "",
          duration: Number(item.duration) || 0,
          synced: Boolean(picked.lrc),
        },
        meta,
      );
      if (score > bestScore) {
        bestScore = score;
        best = picked;
      }
    }
    if (best && bestScore >= 60) break;
  }
  // A loose match is worse than no lyrics: it shows the wrong words on screen.
  return { hit: bestScore >= 45 ? best : null, failed };
}

async function lookup(meta, timeoutMs, deadline) {
  const exact = await exactMatch(meta, timeoutMs, deadline);
  if (exact.hit) return { hit: exact.hit, failed: false };
  if (deadline && Date.now() > deadline) return { hit: null, failed: exact.failed };
  const search = await searchFallback(meta, timeoutMs, deadline);
  if (search.hit) return { hit: search.hit, failed: false };
  return { hit: null, failed: exact.failed || search.failed };
}

// ---------------------------------------------------------------------------
// Cache, keyed by track id
// ---------------------------------------------------------------------------

function cacheGet(id) {
  try {
    return host.storage.get(CACHE_PREFIX + id) || null;
  } catch (e) {
    return null;
  }
}

function cacheSet(id, value) {
  try {
    host.storage.set(CACHE_PREFIX + id, value);
  } catch (e) {
    console.warn("cache:", String((e && e.message) || e));
  }
}

function lineCount(entry) {
  if (!entry) return 0;
  if (entry.lrc) {
    return String(entry.lrc).split(/\r?\n/).filter((l) => /\[\d{1,3}:\d{2}/.test(l)).length;
  }
  if (Array.isArray(entry.lines)) return entry.lines.length;
  return 0;
}

function cacheFresh(entry, cacheHours) {
  if (cacheHours === 0) return false; // caching disabled
  const at = Number(entry.at) || 0;
  if (!at) return false;
  const age = Date.now() - at;
  const ttl = cacheHours * 60 * 60 * 1000;
  // Only a miss we actually checked may be trusted. Entries written by older
  // versions (which cached network errors as misses) are looked up again.
  if (entry.miss) return entry.checked === true && age < Math.min(ttl, MISS_TTL_MS);
  // Short results get a second look, but not on every play.
  const short = lineCount(entry) <= SHORT_LYRIC_LINES;
  return age < Math.min(ttl, short ? SHORT_RECHECK_MS : ttl);
}

function cacheRemove(id) {
  try {
    host.storage.remove(CACHE_PREFIX + id);
  } catch (e) {
    /* nothing stored yet */
  }
}

function toAnswer(entry) {
  if (!entry || entry.miss) return { lrc: "" };
  if (entry.lrc) {
    const out = { lrc: entry.lrc };
    if (entry.translation) out.translation = entry.translation;
    return out;
  }
  if (Array.isArray(entry.lines) && entry.lines.length) return { lines: entry.lines };
  return { lrc: "" };
}

function resolveMeta(id) {
  return ensureCatalog().then((c) => {
    const row = c.byID.get(String(id));
    return row ? metadata(row) : null;
  });
}

// ---------------------------------------------------------------------------
// Writing .lrc beside the songs, for the built-in Local Files source
// ---------------------------------------------------------------------------

async function writeSidecars(list) {
  if (!list.length) return;
  const p = host.spawn(helperPath(), ["sync"]);
  for (const item of list) p.write(JSON.stringify(item) + "\n");
  try {
    p.closeStdin();
  } catch (e) {
    /* already closed by the runtime */
  }
  let text = "";
  for (;;) {
    const line = await withTimeout(p.readLine(), 10000, null);
    if (line === null || line === undefined) break;
    text += line;
  }
  const code = await withTimeout(p.wait(), 5000, -1);
  if (code !== 0) throw new Error(`read-index sync exited ${code}`);
  console.log("sidecars:", text.trim());
}

// syncOnce finds lyrics for a bounded batch of songs and writes the synced
// ones beside the files. It is called by account() (the app asks that at
// startup / in Settings) and played(), so it also covers listeners who play
// from the built-in Local Files source and never open this plugin's pages.
async function syncOnce() {
  if (syncRunning || !boolSetting("writeLrc")) return;
  const interval = numberSetting("syncIntervalMinutes", 15, 1, 1440) * 60 * 1000;
  if (Date.now() - lastSyncAt < interval) return;
  syncRunning = true;
  try {
    const c = await ensureCatalog();
    const timeoutMs = Math.min(numberSetting("timeoutMs", DEFAULT_TIMEOUT_MS, 1000, 20000), 5000);
    const cacheHours = numberSetting("cacheHours", DEFAULT_CACHE_HOURS, 0, 24 * 365);
    const limit = numberSetting("syncLimit", 25, 1, 500);
    const deadline = Date.now() + SYNC_BUDGET_MS;
    const sidecars = [];
    let asked = 0;
    for (const row of c.list) {
      if (Date.now() > deadline || asked >= limit) break;
      const id = String(row.id);
      const cached = cacheGet(id);
      if (cached && cacheFresh(cached, cacheHours)) {
        if (cached.lrc) sidecars.push({ path: row.path, lrc: cached.lrc });
        continue;
      }
      const meta = metadata(row);
      if (!meta.title || !meta.artist) continue;
      asked++;
      const r = await lookup(meta, timeoutMs, deadline);
      if (r.hit) {
        cacheSet(id, Object.assign({ at: Date.now() }, r.hit));
        if (r.hit.lrc) sidecars.push({ path: row.path, lrc: r.hit.lrc });
      } else if (!r.failed) {
        cacheSet(id, { at: Date.now(), miss: true, checked: true });
      }
      await sleep(SYNC_PAUSE_MS);
    }
    await writeSidecars(sidecars);
    lastSyncAt = Date.now();
  } catch (e) {
    console.warn("sync:", String((e && e.message) || e));
  } finally {
    syncRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Exports: everything the app can call
// ---------------------------------------------------------------------------

export async function setSetting({ key, value }) {
  if (key === "library" || key === "endpoint") {
    catalog = null;
    catalogAt = 0;
  }
  if (key === "writeLrc" && boolSetting("writeLrc")) await syncOnce();
}

// account is the earliest call the app makes to a plugin (Settings > Plugins
// and the active source's startup), so it starts the .lrc sync. It answers an
// account, not null, so the app doesn't offer a Sign In button.
export async function account() {
  syncOnce();
  return { id: "local", name: t("Your Library"), imageUrl: "" };
}

// played is asked even when this plugin isn't the track's source, so it keeps
// filling in .lrc files while the listener plays from built-in Local Files.
export function played() {
  syncOnce();
}

export async function lyrics({ id }) {
  if (!id) return { lrc: "" };
  const timeoutMs = numberSetting("timeoutMs", DEFAULT_TIMEOUT_MS, 1000, 20000);
  const cacheHours = numberSetting("cacheHours", DEFAULT_CACHE_HOURS, 0, 24 * 365);

  const key = String(id);
  const cached = cacheGet(key);
  if (cached && cacheFresh(cached, cacheHours)) return toAnswer(cached);
  if (cached && cacheHours === 0) cacheRemove(key);

  const meta = await resolveMeta(key);
  if (!meta || !meta.title) return { lrc: "" };

  const r = await lookup(meta, timeoutMs);
  if (r.hit) {
    if (cacheHours > 0) cacheSet(key, Object.assign({ at: Date.now() }, r.hit));
    return toAnswer(r.hit);
  }
  if (!r.failed && cacheHours > 0) cacheSet(key, { at: Date.now(), miss: true, checked: true });
  return { lrc: "" };
}

export async function home() {
  const c = await ensureCatalog();
  return {
    title: t("Your Library"),
    subtitle: t("Synced lyrics from LRCLib"),
    description: t("Found lyrics are also written as .lrc beside your songs, so they show while you play from Local Files."),
    sections: [
      {
        title: t("All Songs"),
        tracks: c.list.slice(0, SEARCH_PAGE_SIZE).map(toTrack),
        morePage: "songs",
        empty: emptyHint(),
      },
    ],
  };
}

function groups(c, kind) {
  const map = new Map();
  for (const row of c.list) {
    const names = kind === "albums" ? [row.album || ""] : splitArtists(row.artist);
    for (const name of names) {
      if (!name) continue;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(row);
    }
  }
  return map;
}

export async function browse({ page }) {
  const c = await ensureCatalog();
  if (page === "songs") {
    return {
      title: t("All Songs"),
      sections: [{ tracks: c.list.map(toTrack), empty: emptyHint() }],
    };
  }
  if (page === "albums") {
    const albums = Array.from(groups(c, "albums").entries()).map(([name, rows]) => ({
      id: "al:" + name,
      name,
      imageUrl: rows[0].cover ? fileURL(rows[0].cover) : "",
    }));
    return {
      title: t("Albums"),
      sections: [{ title: t("Albums"), albums, empty: emptyHint() }],
    };
  }
  if (page === "artists") {
    const artists = Array.from(groups(c, "artists").keys()).map((name) => ({
      id: "a:" + name,
      name,
    }));
    return {
      title: t("Artists"),
      sections: [{ title: t("Artists"), artists, empty: emptyHint() }],
    };
  }
  throw fail("unavailable", t("No such page"));
}

export async function album({ id }) {
  const c = await ensureCatalog();
  const name = String(id || "").replace(/^al:/, "");
  const rows = groups(c, "albums").get(name) || [];
  return {
    album: {
      id,
      name,
      imageUrl: rows.length && rows[0].cover ? fileURL(rows[0].cover) : "",
    },
    tracks: rows.map(toTrack),
  };
}

export async function artist({ id }) {
  const c = await ensureCatalog();
  const name = String(id || "").replace(/^a:/, "");
  const rows = groups(c, "artists").get(name) || [];
  return {
    artist: { id, name },
    tracks: rows.map(toTrack),
    albums: [],
  };
}

export async function search({ query, kind, offset }) {
  const q = normalize(query);
  const c = await ensureCatalog();
  const at = Math.max(0, Number(offset) || 0);
  const matches = (row) => {
    const hay = normalize([row.title || baseName(row.path), row.artist, row.album].join(" "));
    return q.split(" ").every((w) => !w || hay.includes(w));
  };
  if (kind === "albums") {
    const all = Array.from(groups(c, "albums").entries())
      .filter(([name]) => !q || normalize(name).includes(q))
      .map(([name, rows]) => ({
        id: "al:" + name,
        name,
        imageUrl: rows[0].cover ? fileURL(rows[0].cover) : "",
      }));
    return { albums: all.slice(at, at + SEARCH_PAGE_SIZE), more: at + SEARCH_PAGE_SIZE < all.length };
  }
  if (kind === "artists") {
    const all = Array.from(groups(c, "artists").keys())
      .filter((name) => !q || normalize(name).includes(q))
      .map((name) => ({ id: "a:" + name, name }));
    return { artists: all.slice(at, at + SEARCH_PAGE_SIZE), more: at + SEARCH_PAGE_SIZE < all.length };
  }
  if (kind && kind !== "tracks") return {};
  const found = q ? c.list.filter(matches) : c.list;
  return {
    tracks: found.slice(at, at + SEARCH_PAGE_SIZE).map(toTrack),
    more: at + SEARCH_PAGE_SIZE < found.length,
  };
}

export async function stream({ id }) {
  const c = await ensureCatalog();
  const row = c.byID.get(String(id));
  if (!row) throw fail("unavailable", t("This song is no longer in the local library"));
  return {
    url: fileURL(row.path),
    type: audioType(row.path),
    size: Number(row.size) || 0,
  };
}
