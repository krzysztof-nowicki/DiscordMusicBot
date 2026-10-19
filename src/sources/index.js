// Sources API (agent S). Contract: DESIGN.md "Sources API" + "Cloud: Northflank free plan".
//
// resolve(query, {limit=1, playlistLimit=500, signal}) -> {tracks: Track[], playlist?: {title, url, count, truncated?}}
//   URL -> detected source (YouTube, Spotify, SoundCloud, Bandcamp, Discord attachment, radio, audio file, any
//   yt-dlp site); playlists/albums expand. Plain text -> YouTube search ranked toward Official Audio/Topic.
//   Prefixes "yt:", "sc:", "local:", "sp:" force a source; "spotify:track:…" URIs work. Throws SourceError.
// search(query, {source='youtube'|'soundcloud'|'local', limit=5}) -> Track[]   never throws, <= 2.4 s, LRU cached
// createStream(track, {seekSec, volume, signal, loudnorm, mode}) -> {stream, type: 'raw'|'ogg/opus', kill(),
//   fallback?, fallbackTrack?}   (volume = percent, applied by ffmpeg only in opus mode)
// prefetch(track) -> warms the Spotify match + direct stream URL. Never throws.
// localLibrary() -> {scan({force}), search(q, limit), list(dir, {recursive}), get(relOrAbs)}  (lazy, cached)
// ensureTools({update}) -> yt-dlp/ffmpeg (+deno) ready; call once at startup.
import { getLibrary } from './local.js';

export { makeTrack, SourceError } from './track.js';
export { resolve, search } from './resolve.js';
export { createStream, prefetch } from './stream.js';
export { ensureTools } from '../tools.js';

/**
 * Local library over config.musicDir (singleton). Nothing is scanned until the first search/list/scan call;
 * after that the index is cached (data/library.json) and refreshed in the background at most every 10 min.
 * list(dir): folder path relative to MUSIC_DIR ('' = root); `dirs` = relative paths of direct subfolders,
 * `tracks` = files directly in it; {recursive: true} returns every track below it (for `/local all`).
 * @returns {{scan: (opts?: {force?: boolean}) => Promise<number>,
 *            search: (q: string, limit?: number) => Promise<import('./track.js').Track[]>,
 *            list: (dir?: string, opts?: {recursive?: boolean}) => Promise<{dir: string, dirs: string[], tracks: import('./track.js').Track[]}>,
 *            get: (relOrAbs: string) => Promise<import('./track.js').Track|null>}}
 */
export function localLibrary() {
  const lib = getLibrary();
  return {
    scan: (opts) => lib.scan(opts),
    search: (q, limit) => lib.search(q, limit),
    list: (dir, opts) => lib.list(dir, opts),
    get: (p) => lib.get(p),
  };
}
