// A stand-in for MyGo Music's plugin runtime, so index.js can be tested with
// plain Node. It covers the parts of `host` the plugin uses and a `fetch` that
// answers LRCLib-shaped JSON instead of going to the network.

export function makeHost(options = {}) {
  const {
    platform = "darwin",
    arch = "arm64",
    dir = "/tmp/mygo-lyrics-plugin",
    dataDir = "/tmp/mygo-music/plugin-data/lrclib-lyrics",
    settings = {},
    storage = {},
    index = [],
    translations = {},
    responses = [],
    spawnError = null,
    catalogFails = 0,
  } = options;

  const calls = { fetch: [], spawn: [], storage: [], sync: [] };
  let catalogTries = 0;
  const host = {
    platform,
    arch,
    dir,
    dataDir,
    setting: (key) => settings[key] ?? "",
    t: (text) => translations[text] ?? text,
    language: () => "en",
    storage: {
      get: (key) => {
        calls.storage.push(["get", key]);
        return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
      },
      set: (key, value) => {
        calls.storage.push(["set", key]);
        storage[key] = value;
      },
      remove: (key) => {
        calls.storage.push(["remove", key]);
        delete storage[key];
      },
    },
    spawn: (command, args = []) => {
      calls.spawn.push({ command, args });
      if (spawnError) throw new Error(spawnError);
      const mode = args[0] === "sync" ? "sync" : args[0] === "defaults" ? "defaults" : "index";
      let lines;
      if (mode === "sync") {
        lines = [];
      } else if (mode === "defaults") {
        lines = ["defaults written", null];
      } else {
        catalogTries++;
        lines = catalogTries <= catalogFails
          ? [null]
          : [JSON.stringify(index), null];
      }
      const written = [];
      return {
        readLine: async () => lines.shift() ?? null,
        wait: async () => (mode === "index" && catalogTries <= catalogFails ? 1 : 0),
        write: (text) => written.push(text),
        closeStdin: () => {
          calls.sync.push(...written.map((x) => JSON.parse(x)));
        },
        errorOutput: () => "helper couldn't read the index",
      };
    },
  };

  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.fetch.push({ url: u, init });
    const found = responses.find((r) => (r.match || (() => true))(u));
    if (!found) return { ok: false, status: 404, json: async () => null };
    if (found.status === 404 || found.status === 400) return { ok: false, status: found.status, json: async () => null };
    if (found.error) throw new Error(found.error);
    return {
      ok: found.status ? found.status >= 200 && found.status < 300 : true,
      status: found.status ?? 200,
      json: async () => found.json,
    };
  };

  return { host, fetch, calls, storage, settings };
}

export function trackRow(overrides = {}) {
  return {
    id: "id1",
    path: "/Music/Radiohead - Creep.mp3",
    size: 12345,
    title: "Creep",
    artist: "Radiohead",
    album: "Pablo Honey",
    duration: 238000,
    cover: "",
    ...overrides,
  };
}

export const syncedLRC = [
  "[00:19.16] When you were here before",
  "[00:24.09] Couldn't look you in the eye",
  "[00:29.24] You're just like an angel",
  "[00:34.49] Your skin makes me cry",
  "[00:39.77] You float like a feather",
  "[00:45.00] In a beautiful world",
].join("\n");

export const plainLyrics = [
  "When you were here before",
  "Couldn't look you in the eye",
  "You're just like an angel",
  "Your skin makes me cry",
  "You float like a feather",
  "In a beautiful world",
].join("\n");

// loadPlugin imports index.js with host/fetch injected as globals. The module
// keeps its state between calls, so `reset: true` gives a fresh plugin.
export async function loadPlugin(options = {}, reset = true) {
  const env = makeHost(options);
  globalThis.host = env.host;
  globalThis.fetch = env.fetch;
  const url = reset ? `file://${process.cwd()}/index.js?t=${Math.random()}` : undefined;
  const mod = reset ? await import(url) : await import(`file://${process.cwd()}/index.js`);
  return { ...mod, ...env };
}
