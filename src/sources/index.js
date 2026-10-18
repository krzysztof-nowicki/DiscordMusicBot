// Sources API (agent S). Contract: DESIGN.md "Sources API". Implementations land in sibling modules.
import { SourceError } from './track.js';

export { makeTrack, SourceError } from './track.js';

/**
 * Resolve a query or URL into tracks. Playlists/albums expand; plain text is a YouTube search.
 * Prefixes "yt:", "sc:", "local:" force a source; "spotify:track:…" URIs work.
 * @param {string} query
 * @param {{limit?: number, playlistLimit?: number}} [opts]
 * @returns {Promise<{tracks: import('./track.js').Track[], playlist?: {title: string, url?: string, count: number}}>}
 */
export async function resolve(query, { limit = 1, playlistLimit = 500 } = {}) {
  throw new SourceError('UNSUPPORTED', 'resolve() not implemented yet');
}

/**
 * Fast search for autocomplete (< 2.5 s, cached).
 * @param {string} query
 * @param {{source?: 'youtube'|'soundcloud'|'local', limit?: number}} [opts]
 * @returns {Promise<import('./track.js').Track[]>}
 */
export async function search(query, { source = 'youtube', limit = 5 } = {}) {
  return [];
}

/**
 * Open a PCM stream (s16le, 48 kHz, stereo) for a track.
 * @param {import('./track.js').Track} track
 * @param {{seekSec?: number, signal?: AbortSignal, loudnorm?: boolean}} [opts]
 * @returns {Promise<{stream: import('node:stream').Readable, kill: () => void}>}
 */
export async function createStream(track, { seekSec = 0, signal, loudnorm = false } = {}) {
  throw new SourceError('STREAM_FAILED', 'createStream() not implemented yet');
}

/** Optional warm-up: resolve the direct stream URL (and Spotify→YouTube match) ahead of time. Never throws. */
export async function prefetch(track) {}

/**
 * Local library over config.musicDir (singleton). search/list scan lazily on first use.
 * list(dir) takes a folder path relative to MUSIC_DIR ('' = root); `dirs` are relative paths of direct subfolders,
 * `tracks` the files directly in it. list(dir, {recursive: true}) returns every track below it (for `/local all`).
 * @returns {{scan: (opts?: {force?: boolean}) => Promise<number>,
 *            search: (q: string, limit?: number) => Promise<import('./track.js').Track[]>,
 *            list: (dir?: string, opts?: {recursive?: boolean}) => Promise<{dir: string, dirs: string[], tracks: import('./track.js').Track[]}>}}
 */
export function localLibrary() {
  return { scan: async () => 0, search: async () => [], list: async (dir = '') => ({ dir, dirs: [], tracks: [] }) };
}

/** Ensure yt-dlp (and deno) exist and are fresh; call once at startup. */
export { ensureTools } from '../tools.js';
