// Small JSON-file persistence: per-guild settings (data/settings.json) and saved playlists (data/playlists.json).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let dataDir = config.dataDir;
/** @type {Map<string, any>} file name -> parsed content (cached) */
const cache = new Map();

/** For tests: point the store at another folder. */
export function setDataDir(dir) {
  dataDir = dir;
  cache.clear();
}

function read(name) {
  if (cache.has(name)) return cache.get(name);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')) ?? {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] ${name} unreadable (${e.message}); starting empty`);
  }
  cache.set(name, data);
  return data;
}

/** Atomic write: temp file + rename, so a crash never leaves half a JSON file. */
function write(name) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name), null, 2));
  fs.renameSync(tmp, file);
}

export const settings = {
  /** @returns {{volume?: number, autoplay?: boolean}} */
  get(guildId) {
    return { ...(read('settings.json')[guildId] ?? {}) };
  },
  set(guildId, patch) {
    const all = read('settings.json');
    all[guildId] = { ...(all[guildId] ?? {}), ...patch };
    write('settings.json');
  },
};

const key = (name) => String(name).trim().toLowerCase();

export const playlists = {
  /** @returns {{name: string, tracks: object[], savedBy: string, savedAt: string}[]} */
  list(guildId) {
    return Object.values(read('playlists.json')[guildId] ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  },
  get(guildId, name) {
    return read('playlists.json')[guildId]?.[key(name)] ?? null;
  },
  save(guildId, name, tracks, savedBy) {
    const all = read('playlists.json');
    all[guildId] ??= {};
    // requestedBy belongs to the session that queued it; everything else (incl. streamUrl) is kept.
    const clean = tracks.map(({ requestedBy, ...rest }) => rest);
    all[guildId][key(name)] = { name: String(name).trim(), tracks: clean, savedBy, savedAt: new Date().toISOString() };
    write('playlists.json');
    return all[guildId][key(name)];
  },
  delete(guildId, name) {
    const all = read('playlists.json');
    if (!all[guildId]?.[key(name)]) return false;
    delete all[guildId][key(name)];
    write('playlists.json');
    return true;
  },
};
