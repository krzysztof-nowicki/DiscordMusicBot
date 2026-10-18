// Pure query classification: which source handles a /play input. No I/O (tested offline).
import path from 'node:path';

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;
const YT_ID = /^[\w-]{11}$/;
const SP_ID = /^[A-Za-z0-9]{22}$/;

/**
 * @typedef {{kind:'youtube', type:'video'|'playlist'|'other', id?:string, url:string}
 *   | {kind:'spotify', type:'track'|'album'|'playlist'|'artist', id:string}
 *   | {kind:'spotify-short', url:string}
 *   | {kind:'soundcloud'|'bandcamp', type:'track'|'playlist', url:string}
 *   | {kind:'url', url:string}
 *   | {kind:'local', q:string}
 *   | {kind:'search', source:'youtube'|'soundcloud', q:string}} Detected
 */

/** @returns {Detected} */
export function detect(input) {
  const q = String(input ?? '').trim().replace(/^<(.+)>$/, '$1'); // Discord <url> (no embed) syntax

  const pre = /^(yt|youtube|sc|soundcloud|local|sp|spotify):(?!\/\/)\s*(.*)$/is.exec(q);
  if (pre) {
    const tag = pre[1].toLowerCase();
    const rest = pre[2].trim();
    if (tag === 'local') return { kind: 'local', q: rest };
    if (tag === 'sp' || tag === 'spotify') {
      const m = /^(track|album|playlist|artist):([A-Za-z0-9]{22})$/i.exec(rest);
      if (m) return { kind: 'spotify', type: m[1].toLowerCase(), id: m[2] };
      if (SP_ID.test(rest)) return { kind: 'spotify', type: 'track', id: rest };
      return detect(rest);
    }
    if (/^https?:\/\//i.test(rest)) return detect(rest);
    if (tag === 'yt' || tag === 'youtube') {
      if (YT_ID.test(rest) && /[A-Z0-9_-]/.test(rest) && /[a-z]/.test(rest)) {
        return { kind: 'youtube', type: 'video', id: rest, url: `https://www.youtube.com/watch?v=${rest}` };
      }
      return { kind: 'search', source: 'youtube', q: rest };
    }
    return { kind: 'search', source: 'soundcloud', q: rest };
  }

  // Absolute local path (C:\..., \\server\share, /home/...) that the caller can stat.
  if (/^[a-z]:[\\/]/i.test(q) || q.startsWith('\\\\') || (process.platform !== 'win32' && q.startsWith('/'))) {
    return { kind: 'local', q: path.normalize(q) };
  }

  let u;
  try {
    u = /^https?:\/\//i.test(q) ? new URL(q) : null;
  } catch {
    u = null;
  }
  if (!u) return { kind: 'search', source: 'youtube', q };

  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' && parts[0] && YT_ID.test(parts[0])) {
    return { kind: 'youtube', type: 'video', id: parts[0], url: `https://www.youtube.com/watch?v=${parts[0]}` };
  }
  if (YT_HOSTS.test(host)) {
    const v = u.searchParams.get('v');
    // watch?v=X&list=Y plays just the video (a pasted link from inside a playlist/mix is usually meant that way).
    if (parts[0] === 'watch' && v && YT_ID.test(v)) return { kind: 'youtube', type: 'video', id: v, url: `https://www.youtube.com/watch?v=${v}` };
    if (['shorts', 'live', 'embed', 'v'].includes(parts[0]) && parts[1] && YT_ID.test(parts[1])) {
      return { kind: 'youtube', type: 'video', id: parts[1], url: `https://www.youtube.com/watch?v=${parts[1]}` };
    }
    const list = u.searchParams.get('list');
    if (parts[0] === 'playlist' && list) return { kind: 'youtube', type: 'playlist', id: list, url: `https://www.youtube.com/playlist?list=${list}` };
    return { kind: 'youtube', type: 'other', url: u.href };
  }

  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const p = parts.filter((x) => !/^intl-/i.test(x) && x !== 'embed');
    if (['track', 'album', 'playlist', 'artist'].includes(p[0]) && SP_ID.test(p[1] || '')) return { kind: 'spotify', type: p[0], id: p[1] };
    return { kind: 'url', url: u.href };
  }
  if (host === 'spotify.link' || host.endsWith('.app.link')) return { kind: 'spotify-short', url: u.href };

  if (host === 'soundcloud.com' || host === 'm.soundcloud.com' || host === 'on.soundcloud.com' || host === 'api.soundcloud.com') {
    return { kind: 'soundcloud', type: parts[1] === 'sets' || parts.includes('sets') ? 'playlist' : 'track', url: u.href };
  }
  if (host.endsWith('.bandcamp.com')) return { kind: 'bandcamp', type: parts[0] === 'track' ? 'track' : 'playlist', url: u.href };

  return { kind: 'url', url: u.href };
}

/** File extensions treated as plain audio files (direct URL or local). */
export const AUDIO_EXT = ['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'wav', 'aac', 'wma', 'webm', 'mka'];

/** Playlist-file extensions used by radio stations. */
export const PLAYLIST_EXT = ['m3u', 'm3u8', 'pls'];
