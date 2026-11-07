#!/usr/bin/env node
// sync-lrc finds LRCLib lyrics for the app's local library and writes a .lrc
// beside each song that has none. MyGo Music's built-in Local Files source
// reads those files itself, so lyrics then show while playing from Local Files,
// where the app never asks a plugin for lyrics.
//
// It loads the plugin's own index.js with a stand-in host, so the lookup,
// matching and caching are exactly the ones the app uses. The same cache
// (plugin-data/lrclib-lyrics/storage.json) is shared, so a lyric found here
// is also a cache hit when the plugin is the active source.
//
//   node scripts/sync-lrc.mjs [--limit N] [--all] [--pause MS] [--quiet]
//
// With no network proxy it still works wherever Node's fetch can reach
// LRCLib; set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 where one is needed.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const limit = args.includes("--all") ? Number.MAX_SAFE_INTEGER : Number(arg("--limit", "25"));
const pause = Number(arg("--pause", "150"));
const quiet = args.includes("--quiet");
const say = (...x) => { if (!quiet) console.log(...x); };

function appDataDir() {
  if (process.env.MYGO_APP_DATA) return process.env.MYGO_APP_DATA;
  switch (process.platform) {
    case "darwin": return path.join(process.env.HOME, "Library/Application Support/MyGo Music");
    case "win32": return path.join(process.env.APPDATA || "", "MyGo Music");
    default: return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local/share"), "MyGo Music");
  }
}

const goos = process.platform === "win32" ? "windows" : process.platform;
const goarch = process.arch === "x64" ? "amd64" : process.arch;
const helper = path.join(root, "bin", `read-index-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`);
const data = path.join(appDataDir(), "plugin-data", "lrclib-lyrics");
const pluginDir = existsSync(path.join(root, "index.js")) ? root : path.join(appDataDir(), "plugins", "lrclib-lyrics");
const settingsPath = path.join(data, "settings.json");
const storagePath = path.join(data, "storage.json");
const libraryPath = path.join(appDataDir(), "local", "index.json");

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, file);
}

// runHelper answers the helper program's stdout lines and exit code, through
// the same interface as the app's host.spawn.
function runHelper(args, input = "") {
  const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => lines.push(line));
  let stderr = "";
  child.stderr.on("data", (b) => { stderr += b; });
  let cursor = 0;
  const done = new Promise((resolve) => {
    child.on("close", (code) => { rl.close(); resolve(code ?? -1); });
  });
  if (input) child.stdin.end(input);
  const waiters = [];
  const wake = () => { while (waiters.length) waiters.shift()(); };
  rl.on("line", wake);
  rl.on("close", wake);
  return {
    readLine: async () => {
      for (;;) {
        if (cursor < lines.length) return lines[cursor++];
        if (rl.closed && cursor >= lines.length) return null;
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
    wait: () => done,
    write: (s) => child.stdin.write(s),
    closeStdin: () => child.stdin.end(),
    errorOutput: () => stderr,
  };
}

async function main() {
  if (!existsSync(helper)) {
    throw new Error(`missing ${helper}; run npm run build:helpers first`);
  }
  if (!existsSync(libraryPath)) {
    throw new Error(`no local library at ${libraryPath}; add your songs in MyGo Music first`);
  }
  if (!existsSync(settingsPath)) {
    await mkdir(data, { recursive: true });
    const p = runHelper(["defaults", data, libraryPath]);
    await p.readLine();
    await p.wait();
  }
  const settings = await readJSON(settingsPath, {});
  const storage = await readJSON(storagePath, {});

  const host = {
    platform: goos,
    arch: goarch,
    dir: pluginDir,
    dataDir: data,
    setting: (key) => String(settings[key] ?? ""),
    t: (s) => s,
    language: () => "en",
    storage: {
      get: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
      set: async (key, value) => {
        storage[key] = value;
        await writeJSON(storagePath, storage);
      },
      remove: async (key) => {
        delete storage[key];
        await writeJSON(storagePath, storage);
      },
    },
    spawn: (command, argv) => runHelper(argv),
  };
  globalThis.host = host;
  const plugin = await import(`file://${path.join(root, "index.js")}?t=${Date.now()}`);

  // The helper computes the same ids as the app's local source.
  const p = runHelper([settings.library || libraryPath]);
  let text = "";
  for (;;) {
    const line = await p.readLine();
    if (line === null || line === undefined) break;
    text += line;
  }
  if (await p.wait() !== 0) throw new Error(p.errorOutput() || "read-index failed");
  const rows = JSON.parse(text);
  say(`local library: ${rows.length} songs, looking at up to ${limit} without .lrc`);

  let asked = 0, written = 0, skipped = 0, missing = 0;
  for (const row of rows) {
    if (asked >= limit) break;
    const base = row.path.replace(/\.[^.\\/]+$/, "");
    if (existsSync(base + ".lrc") || existsSync(base + ".LRC")) {
      skipped++;
      continue;
    }
    asked++;
    let answer;
    try {
      answer = await plugin.lyrics({ id: row.id });
    } catch (e) {
      say("  failed:", row.title, String(e.message || e));
      continue;
    }
    if (answer && answer.lrc) {
      const tmp = base + ".lrc.tmp";
      await writeFile(tmp, answer.lrc, "utf8");
      await rename(tmp, base + ".lrc");
      written++;
      say(`  + ${row.artist || "?"} - ${row.title}`);
    } else {
      missing++;
    }
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  }
  say(`done: ${written} .lrc written, ${missing} not found, ${skipped} already had one`);
}

main().catch((e) => {
  console.error(`sync-lrc: ${e.message}`);
  process.exitCode = 1;
});
