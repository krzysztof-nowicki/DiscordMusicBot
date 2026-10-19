// Local music library over MUSIC_DIR: recursive scan, tags via music-metadata, index cached in data/library.json
// (entries re-read only when a file's mtime/size changes), accent-insensitive fuzzy search, folder listing.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { config } from '../config.js';
import { makeTrack } from './track.js';
import { lev, norm, readJson, tokens, writeJson } from './util.js';

export const LOCAL_EXT = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.wav', '.aac', '.wma']);
const RESCAN_AFTER_MS = 10 * 60_000;
const INDEX_VERSION = 1;

// ---------- which files may be played ----------
const extraRoots = new Set();
const isUnc = (p) => /^[\\/]{2}/.test(String(p));
const cmpPath = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}
/** Also allow files under `dir` (createLibrary() roots, tests). MUSIC_DIR is always allowed. */
export function allowLocalRoot(dir) {
  extraRoots.add(path.resolve(dir));
}
/**
 * True only for an existing audio file (LOCAL_EXT) whose real path (symlinks resolved) is inside MUSIC_DIR or an
 * allowed root. UNC paths are rejected without touching the network.
 */
export function isAllowedLocalFile(p) {
  if (!p || isUnc(p) || !LOCAL_EXT.has(path.extname(String(p)).toLowerCase())) return false;
  const real = realOrNull(p);
  if (!real || isUnc(real)) return false;
  for (const r of [config.musicDir, ...extraRoots]) {
    if (isUnc(r)) continue;
    const root = realOrNull(r);
    if (!root) continue;
    const rel = path.relative(cmpPath(root), cmpPath(real));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** "01. Main Title" -> "Main Title" */
const cleanName = (f) => path.parse(f).name.replace(/^\s*\d{1,3}\s*[-._)]\s*/, '').replace(/_/g, ' ').trim();
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

async function walk(dir, out) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  await Promise.all(ents.map(async (e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !/^\$RECYCLE\.BIN$/i.test(e.name)) await walk(p, out);
    } else if (e.isFile() && LOCAL_EXT.has(path.extname(e.name).toLowerCase())) {
      try { const st = await fsp.stat(p); out.push({ abs: p, mtimeMs: Math.round(st.mtimeMs), size: st.size }); } catch {}
    }
  }));
}

async function readTags(abs) {
  try {
    const { common, format } = await parseFile(abs, { skipCovers: true, duration: false });
    return {
      title: common.title?.trim() || undefined,
      artist: (common.artist || common.albumartist)?.trim() || undefined,
      album: common.album?.trim() || undefined,
      trackNo: common.track?.no ?? undefined,
      durationSec: format.duration ? Math.round(format.duration) : undefined,
    };
  } catch {
    return {};
  }
}

/** Haystack tokens for an entry (title, artist, album, file name and folder names). */
function entryTokens(rel, e) {
  return [...new Set(tokens(`${e.title || ''} ${e.artist || ''} ${e.album || ''} ${rel.replace(/[\\/]/g, ' ')}`))];
}

/**
 * Fuzzy score of an entry for a query (0 = no match). Every query token must match a haystack token:
 * exact (3) > prefix (2) > substring (1.5) > 1-2 typos for longer words (1). Bonus when the title starts with the query.
 */
export function scoreEntry(qTokens, qNorm, hay, titleNorm) {
  let s = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const h of hay) {
      if (h === q) { best = 3; break; }
      if (h.startsWith(q)) best = Math.max(best, 2);
      else if (q.length >= 3 && h.includes(q)) best = Math.max(best, 1.5);
      else if (q.length >= 4 && best < 1 && lev(q, h, q.length >= 8 ? 2 : 1) <= (q.length >= 8 ? 2 : 1)) best = 1;
    }
    if (!best) return 0;
    s += best;
  }
  if (titleNorm.startsWith(qNorm)) s += 2;
  else if (titleNorm.includes(qNorm)) s += 1;
  return s;
}

class LocalLibrary {
  constructor(root = config.musicDir, indexFile = path.join(config.dataDir, 'library.json')) {
    this.root = path.resolve(root);
    this.indexFile = indexFile;
    this.files = null; // rel -> {mtimeMs, size, title, artist, album, trackNo, durationSec}
    this.lastScan = 0;
    this.scanning = null;
  }

  /** Scan MUSIC_DIR (re-reading tags only for new/changed files). Returns the number of tracks. */
  scan({ force = false } = {}) {
    this.scanning ??= (async () => {
      try {
        const cached = await readJson(this.indexFile, null);
        const old = cached?.v === INDEX_VERSION && cached.root === this.root ? cached.files : {};
        const found = [];
        await walk(this.root, found);
        const files = {};
        const todo = [];
        for (const f of found) {
          const rel = toRel(this.root, f.abs);
          const o = old[rel];
          if (!force && o && o.mtimeMs === f.mtimeMs && o.size === f.size) files[rel] = o;
          else todo.push({ rel, f });
        }
        for (let i = 0; i < todo.length; i += 8) {
          await Promise.all(todo.slice(i, i + 8).map(async ({ rel, f }) => {
            files[rel] = { mtimeMs: f.mtimeMs, size: f.size, ...(await readTags(f.abs)) };
          }));
        }
        this.files = files;
        this.prepared = null;
        this.lastScan = Date.now();
        const changed = todo.length || Object.keys(old).length !== found.length;
        if (changed || !cached) await writeJson(this.indexFile, { v: INDEX_VERSION, root: this.root, files }).catch((e) => console.warn('[sources] library.json:', e.message));
        return found.length;
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  async ready() {
    if (!this.files) await this.scan();
    else if (Date.now() - this.lastScan > RESCAN_AFTER_MS && !this.scanning) this.scan().catch(() => {}); // refresh in background
  }

  toTrack(rel) {
    const e = this.files[rel];
    return makeTrack({
      id: `local:${rel}`,
      title: e.title || cleanName(rel),
      artist: e.artist,
      durationSec: e.durationSec,
      source: 'local',
      streamUrl: path.join(this.root, ...rel.split('/')),
    });
  }

  /** @returns {Promise<import('./track.js').Track[]>} */
  async search(q, limit = 10) {
    await this.ready();
    const qNorm = norm(q);
    const qTokens = tokens(q);
    if (!qTokens.length) return [];
    this.prepared ??= Object.keys(this.files).map((rel) => ({ rel, hay: entryTokens(rel, this.files[rel]), title: norm(this.files[rel].title || cleanName(rel)) }));
    return this.prepared
      .map((p) => ({ rel: p.rel, s: scoreEntry(qTokens, qNorm, p.hay, p.title) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.rel.localeCompare(b.rel))
      .slice(0, limit)
      .map((x) => this.toTrack(x.rel));
  }

  /** Folder listing relative to MUSIC_DIR. recursive=true returns every track below `dir` (for "/local all"). */
  async list(dir = '', { recursive = false } = {}) {
    await this.ready();
    const d = String(dir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (d.split('/').includes('..')) return { dir: d, dirs: [], tracks: [] };
    const prefix = d ? `${d}/` : '';
    const dirs = new Set();
    const rels = [];
    for (const rel of Object.keys(this.files)) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1 || recursive) rels.push(rel);
      if (slash !== -1) dirs.add(prefix + rest.slice(0, slash));
    }
    const byOrder = (a, b) => {
      const da = path.posix.dirname(a), db = path.posix.dirname(b);
      if (da !== db) return da.localeCompare(db);
      return (this.files[a].trackNo ?? 1e9) - (this.files[b].trackNo ?? 1e9) || a.localeCompare(b, undefined, { numeric: true });
    };
    return { dir: d, dirs: [...dirs].sort((a, b) => a.localeCompare(b)), tracks: rels.sort(byOrder).map((r) => this.toTrack(r)) };
  }

  /** Track for a relative path or an absolute file path (also outside MUSIC_DIR). */
  async get(relOrAbs) {
    if (!relOrAbs || isUnc(relOrAbs)) return null;
    if (path.isAbsolute(relOrAbs)) {
      if (!isAllowedLocalFile(relOrAbs)) return null; // e.g. C:\Windows\win.ini, files outside MUSIC_DIR
      const st = await fsp.stat(relOrAbs).catch(() => null);
      if (!st?.isFile()) return null;
      const rel = toRel(this.root, relOrAbs);
      if (!rel.startsWith('..') && this.files?.[rel]) return this.toTrack(rel);
      const tags = await readTags(relOrAbs);
      return makeTrack({ id: `local:${relOrAbs}`, title: tags.title || cleanName(relOrAbs), artist: tags.artist, durationSec: tags.durationSec, source: 'local', streamUrl: relOrAbs });
    }
    await this.ready();
    const rel = relOrAbs.replace(/\\/g, '/');
    return this.files[rel] ? this.toTrack(rel) : null;
  }
}

let lib = null;
/** Singleton over config.musicDir. */
export function getLibrary() {
  lib ??= new LocalLibrary();
  return lib;
}
/** For tests: a library over any folder with its own index file. */
export function createLibrary(root, indexFile) {
  allowLocalRoot(root);
  return new LocalLibrary(root, indexFile);
}
