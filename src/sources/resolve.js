// resolve(): query/URL -> {tracks, playlist?}; search(): fast autocomplete search.
import path from 'node:path';
import { ensureTools, run, tools } from '../tools.js';
import { AUDIO_EXT, detect, PLAYLIST_EXT } from './detect.js';
import { getLibrary } from './local.js';
import { rankCandidates } from './match.js';
import { expandShortLink, resolveSpotify } from './spotify.js';
import { primeStreamInfo } from './stream.js';
import { makeTrack, SourceError } from './track.js';
import { BROWSER_UA, fetchT, Lru } from './util.js';
import { candToTrack, ytSearchCandidates } from './youtube.js';
import { entryToTrack, soundcloudSearch, ytdlpJson, ytdlpResolve } from './ytdlp.js';

/** Rank text-search results: match score + a prior for YouTube's own order. */
function rankTextResults(cands, q) {
  const ranked = rankCandidates(cands, { title: q });
  const pos = new Map(cands.map((c, i) => [c.id, i]));
  return ranked.map((r) => ({ ...r, score: r.score + Math.max(0, 12 - 3 * pos.get(r.cand.id)) })).sort((a, b) => b.score - a.score);
}

/** Duration of a media URL/file via ffprobe (null if unknown/live). */
async function probeDuration(input, signal) {
  if (!tools.ffprobe) return null;
  try {
    const r = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input], { timeoutMs: 8000, signal });
    const d = Number(r.stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

function fileTitle(url) {
  try {
    return decodeURIComponent(path.posix.basename(new URL(url).pathname)).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ') || url;
  } catch {
    return url;
  }
}

const extOf = (url) => {
  try { return path.posix.extname(new URL(url).pathname).slice(1).toLowerCase(); } catch { return ''; }
};

/** First stream URL inside an .m3u/.pls playlist. */
export function parseRadioPlaylist(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    const m = /^File\d+=(.+)$/i.exec(l);
    if (m) return m[1].trim();
    if (/^https?:\/\//i.test(l)) return l;
  }
  return null;
}

/** Discord attachment / plain audio URL -> Track (title from the file name, duration via ffprobe). */
async function fileUrlTrack(url, source, signal) {
  return makeTrack({ id: `${source}:${url.split('?')[0]}`, title: fileTitle(url), durationSec: await probeDuration(url, signal), url, source });
}

/** Any other http(s) URL: audio file, radio stream, radio playlist, or a page for yt-dlp. */
async function resolveUrl(url, { playlistLimit, signal }) {
  const ext = extOf(url);
  if (AUDIO_EXT.includes(ext) && ext !== 'webm') {
    const t = await fileUrlTrack(url, 'http', signal);
    if (t.durationSec) return { tracks: [t] };
  }
  let res = null;
  try {
    res = await fetchT(url, { timeoutMs: 8000, signal, headers: { 'user-agent': BROWSER_UA, 'icy-metadata': '0' } });
  } catch {}
  const ct = (res?.headers.get('content-type') || '').toLowerCase();
  const icyName = res?.headers.get('icy-name');
  const isPlaylist = PLAYLIST_EXT.includes(ext) || /mpegurl|scpls|x-pls/.test(ct);
  if (res?.ok && isPlaylist && !/application\/vnd\.apple\.mpegurl/.test(ct) && ext !== 'm3u8') {
    const inner = parseRadioPlaylist(await res.text());
    if (!inner) throw new SourceError('UNSUPPORTED', `empty radio playlist ${url}`);
    return resolveUrl(inner, { playlistLimit, signal }).then((r) => {
      for (const t of r.tracks) if (t.source === 'radio') t.url = url; // keep the station's playlist URL as the link
      return r;
    });
  }
  if (res?.ok && (/^audio\/|application\/ogg|application\/vnd\.apple\.mpegurl/.test(ct) || ext === 'm3u8')) {
    const length = Number(res.headers.get('content-length'));
    res.body?.cancel().catch(() => {});
    const live = !!icyName || !length || ext === 'm3u8';
    if (live) {
      return { tracks: [makeTrack({ id: `radio:${url}`, title: icyName?.trim() || res.headers.get('icy-description') || new URL(url).hostname, url, source: 'radio', isLive: true })] };
    }
    return { tracks: [await fileUrlTrack(url, 'http', signal)] };
  }
  res?.body?.cancel().catch(() => {});
  // A web page: let yt-dlp's generic/site extractors try.
  return ytdlpResolve(url, { playlistLimit, signal });
}

/** Single video/track page via `yt-dlp -j` (also primes the direct-URL cache used by createStream). */
async function resolveSingle(url, signal) {
  const info = await primeStreamInfo(url, { signal });
  const t = entryToTrack(info);
  primeStreamInfo.alias(t.url, url);
  return { tracks: [t] };
}

/**
 * @param {string} query
 * @param {{limit?: number, playlistLimit?: number, signal?: AbortSignal}} [opts]
 */
export async function resolve(query, { limit = 1, playlistLimit = 500, signal } = {}) {
  const d = detect(query);
  if (d.kind !== 'local' && d.kind !== 'spotify') {
    try { await ensureTools(); } catch (e) { throw new SourceError('TOOL_MISSING', e.message); }
  }
  switch (d.kind) {
    case 'search': {
      if (!d.q) throw new SourceError('NOT_FOUND', 'empty query');
      if (d.source === 'soundcloud') {
        const tracks = (await soundcloudSearch(d.q, Math.max(limit, 5), signal)).slice(0, limit);
        if (!tracks.length) throw new SourceError('NOT_FOUND', d.q);
        return { tracks };
      }
      const cands = await ytSearchCandidates(d.q, Math.max(10, limit), { signal });
      if (!cands.length) throw new SourceError('NOT_FOUND', d.q);
      return { tracks: rankTextResults(cands, d.q).slice(0, limit).map((r) => candToTrack(r.cand)) };
    }
    case 'youtube':
      if (d.type === 'video') {
        // watch?v=X&list=RDX is the video's own mix (used by autoplay); other list= params play just the video.
        let list = null;
        try { list = new URL(query.trim()).searchParams.get('list'); } catch {}
        if (list && list === `RD${d.id}`) return ytdlpResolve(`https://www.youtube.com/watch?v=${d.id}&list=${list}`, { playlistLimit, signal });
        return resolveSingle(d.url, signal);
      }
      return ytdlpResolve(d.url, { playlistLimit, signal });
    case 'spotify':
      return resolveSpotify(d.type, d.id, { playlistLimit, signal });
    case 'spotify-short':
      return resolve(await expandShortLink(d.url, signal), { limit, playlistLimit, signal });
    case 'soundcloud':
    case 'bandcamp':
      if (d.type === 'track') return resolveSingle(d.url, signal);
      if (d.kind === 'soundcloud') {
        // Flat SoundCloud set entries carry no titles, so do a full extraction.
        const info = await ytdlpJson(['-J', '--playlist-end', String(playlistLimit), d.url], { timeoutMs: 180_000, signal, errCode: 'UNAVAILABLE' });
        const tracks = (info.entries || [info]).filter(Boolean).map((e) => entryToTrack(e, 'soundcloud'));
        if (!tracks.length) throw new SourceError('NOT_FOUND', d.url);
        return info.entries ? { tracks, playlist: { title: info.title, url: info.webpage_url || d.url, count: tracks.length } } : { tracks };
      }
      return ytdlpResolve(d.url, { playlistLimit, signal });
    case 'attachment':
      return { tracks: [await fileUrlTrack(d.url, 'attachment', signal)] };
    case 'local': {
      const lib = getLibrary();
      const exact = d.q && (await lib.get(d.q));
      if (exact) return { tracks: [exact] };
      const tracks = d.q ? await lib.search(d.q, limit) : [];
      if (!tracks.length) throw new SourceError('LOCAL_MISSING', d.q);
      return { tracks };
    }
    case 'url':
      return resolveUrl(d.url, { playlistLimit, signal });
    default:
      throw new SourceError('UNSUPPORTED', query);
  }
}

// ---------- search (autocomplete) ----------

const SEARCH_DEADLINE_MS = 2400;
const searchCache = new Lru(500, 15 * 60_000);

/**
 * Fast search for autocomplete. Never throws; [] on error or when the deadline (2.4 s) passes
 * (the search keeps running in the background and fills the cache for the next keystroke).
 * @param {string} query
 * @param {{source?: 'youtube'|'soundcloud'|'local', limit?: number}} [opts]
 */
export async function search(query, { source = 'youtube', limit = 5 } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2 || /^https?:\/\//i.test(q)) return [];
  const key = `${source}\u0000${limit}\u0000${q.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit) return hit;
  const work = (async () => {
    if (source === 'local') return getLibrary().search(q, limit);
    if (source === 'soundcloud') {
      await ensureTools();
      return (await soundcloudSearch(q, limit)).slice(0, limit);
    }
    const cands = await ytSearchCandidates(q, Math.max(limit, 10), { fast: true });
    return rankTextResults(cands, q).slice(0, limit).map((r) => candToTrack(r.cand));
  })().then((r) => searchCache.set(key, r)).catch((e) => {
    console.warn(`[sources] search "${q}": ${e.detail || e.message}`);
    return [];
  });
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r([]), SEARCH_DEADLINE_MS); });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
