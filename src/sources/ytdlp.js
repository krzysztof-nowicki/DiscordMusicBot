// yt-dlp wrappers: metadata (-J / --flat-playlist), direct stream URL info, yt-dlp JSON -> Track.
import { ensureTools, run, tools, ytdlpBaseArgs, ytdlpProfile, ytdlpSlots } from '../tools.js';
import { makeTrack, SourceError, throwIfAborted } from './track.js';

/** Map yt-dlp error text to a SourceError. */
export function ytdlpError(stderr, fallback = 'STREAM_FAILED') {
  const s = String(stderr || '');
  let code = fallback;
  if (/not a bot|rate-limited by YouTube/i.test(s)) code = 'BOT_CHECK';
  else if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(s)) code = 'AGE_RESTRICTED';
  else if (/private video|video unavailable|has been removed|not available in your country|members-only|This video is not available|404: Not Found|HTTP Error 404|recording is not available/i.test(s)) code = 'UNAVAILABLE';
  else if (/Unsupported URL|No video formats|is not a valid URL/i.test(s)) code = 'UNSUPPORTED';
  else if (/timed out|getaddrinfo|Connection reset|Temporary failure|HTTP Error 5\d\d|Unable to download/i.test(s)) code = 'NETWORK';
  const line = s.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() || s.trim().split(/\r?\n/).pop() || '';
  return new SourceError(code, `yt-dlp: ${line}`.slice(0, 500));
}

const RETRYABLE = new Set(['BOT_CHECK', 'UNAVAILABLE', 'STREAM_FAILED', 'NETWORK']);
const isYoutubeArg = (args) => args.some((a) => /youtube\.com|youtu\.be|^ytsearch\d*:/.test(a));

async function ytdlpJsonOnce(args, { timeoutMs, signal, errCode, retry }) {
  // Test hook: behave like a datacenter IP that YouTube bot-checks (live test of the SoundCloud fallback).
  if (process.env.SOURCES_SIMULATE_BOT_CHECK === '1' && isYoutubeArg(args)) {
    throw ytdlpError("ERROR: [youtube] simulated: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies");
  }
  const r = await run(tools.ytdlp, [...ytdlpBaseArgs({ retry }), ...args], { timeoutMs, signal });
  if (r.aborted) throw new SourceError('ABORTED', 'aborted');
  if (r.timedOut) throw new SourceError('NETWORK', `yt-dlp timed out: ${args.join(' ')}`);
  const out = r.stdout.trim();
  if (r.code !== 0 && !out) throw ytdlpError(r.stderr, errCode);
  try {
    return JSON.parse(out);
  } catch {
    throw ytdlpError(r.stderr || 'invalid JSON from yt-dlp', errCode);
  }
}

/**
 * Run yt-dlp and parse its JSON. At most YTDLP_CONCURRENCY processes run at once (the rest queue); `lowPriority`
 * work (autocomplete) runs only if a slot is free right now, else it fails fast.
 * A failed YouTube extraction is retried once with the retry player clients (tools.js ytdlpProfile).
 */
export async function ytdlpJson(args, { timeoutMs = 30_000, signal, errCode, lowPriority = false } = {}) {
  throwIfAborted(signal);
  try {
    await ensureTools();
  } catch (e) {
    throw new SourceError('TOOL_MISSING', e.message);
  }
  throwIfAborted(signal);
  if (lowPriority) {
    if (!ytdlpSlots.tryAcquire()) throw new SourceError('NETWORK', 'yt-dlp busy');
  } else {
    await ytdlpSlots.acquire(signal);
  }
  try {
    throwIfAborted(signal);
    try {
      return await ytdlpJsonOnce(args, { timeoutMs, signal, errCode, retry: false });
    } catch (e) {
      if (lowPriority || !isYoutubeArg(args) || !RETRYABLE.has(e.code) || signal?.aborted) throw e;
      console.warn(`[sources] yt-dlp failed (${e.detail}); retrying with the alternate player client`);
      return await ytdlpJsonOnce(args, { timeoutMs, signal, errCode, retry: true });
    }
  } finally {
    ytdlpSlots.release();
  }
}

const SOURCE_BY_EXTRACTOR = { youtube: 'youtube', youtubetab: 'youtube', soundcloud: 'soundcloud', soundcloudset: 'soundcloud', bandcamp: 'bandcamp', bandcampalbum: 'bandcamp' };
const PREFIX = { youtube: 'yt', soundcloud: 'sc', bandcamp: 'bc' };

function bestThumb(e) {
  if (e.thumbnail) return e.thumbnail;
  const t = (e.thumbnails || []).filter((x) => x.url);
  return t.length ? t.sort((a, b) => (b.width || 0) - (a.width || 0))[0].url : undefined;
}

/** yt-dlp info dict (full or flat entry) -> Track. */
export function entryToTrack(e, parentExtractor) {
  const ek = String(e.ie_key || e.extractor_key || parentExtractor || '').toLowerCase().replace(/:.*/, '');
  let source = SOURCE_BY_EXTRACTOR[ek] || 'generic';
  if (source === 'generic' && /youtube\.com|youtu\.be/.test(e.url || e.webpage_url || '')) source = 'youtube';
  const isYt = source === 'youtube';
  const url = isYt && e.id ? `https://www.youtube.com/watch?v=${e.id}` : e.webpage_url || e.original_url || e.url;
  const isLive = e.is_live === true || e.live_status === 'is_live';
  const artist = isYt ? (e.artists?.[0] || e.artist || e.channel || e.uploader) : (e.artist || e.artists?.[0] || e.uploader || e.channel);
  return makeTrack({
    id: source === 'generic' ? `gen:${ek || 'x'}:${e.id ?? url}` : `${PREFIX[source]}:${e.id}`,
    title: (isYt ? e.title : e.track || e.title) || e.id,
    artist: artist ? String(artist).replace(/ - Topic$/, '') : undefined,
    durationSec: isLive ? null : e.duration,
    url,
    thumbnail: isYt && e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : bestThumb(e),
    source,
    isLive,
  });
}

/**
 * Resolve any yt-dlp URL to {tracks, playlist?}. Playlists are listed flat (fast, no per-entry extraction).
 * @param {string} url
 */
export async function ytdlpResolve(url, { playlistLimit = 500, signal } = {}) {
  const info = await ytdlpJson(['--flat-playlist', '-J', '--playlist-end', String(playlistLimit), '--', url], { timeoutMs: 60_000, signal, errCode: 'UNAVAILABLE' });
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const tracks = (info.entries || [])
      .filter((e) => e && e.id && !/^\[(Private|Deleted)/i.test(e.title || ''))
      .slice(0, playlistLimit)
      .map((e) => entryToTrack(e, info.extractor_key));
    if (!tracks.length) throw new SourceError('NOT_FOUND', `empty playlist ${url}`);
    return { tracks, playlist: { title: info.title || url, url: info.webpage_url || url, count: tracks.length } };
  }
  return { tracks: [entryToTrack(info)] };
}

/**
 * Direct media URL + headers for a page URL (`yt-dlp -j -f bestaudio`). `expiresAt` from the URL's expire param.
 * @returns {Promise<{url: string, headers: Record<string,string>, protocol: string, isLive: boolean, expiresAt: number, info: object}>}
 */
export async function ytdlpStreamInfo(pageUrl, { signal } = {}) {
  const info = await ytdlpJson(['-f', ytdlpProfile.format, '--no-playlist', '-j', '--', pageUrl], { timeoutMs: 45_000, signal });
  const fmt = info.requested_formats?.[0] || info;
  if (!fmt.url) throw new SourceError('STREAM_FAILED', `no stream url for ${pageUrl}`);
  let expiresAt = Date.now() + 30 * 60_000;
  try {
    const exp = Number(new URL(fmt.url).searchParams.get('expire'));
    if (exp > 0) expiresAt = exp * 1000 - 5 * 60_000;
  } catch {}
  return {
    url: fmt.url,
    headers: fmt.http_headers || info.http_headers || {},
    protocol: fmt.protocol || info.protocol || 'https',
    isLive: info.is_live === true || info.live_status === 'is_live',
    expiresAt,
    info,
  };
}

/** SoundCloud search via yt-dlp "scsearchN:" (~2 s). */
export async function soundcloudSearch(q, limit, signal, { lowPriority = false } = {}) {
  const info = await ytdlpJson(['--flat-playlist', '-J', '--', `scsearch${limit}:${q}`], { timeoutMs: 20_000, signal, errCode: 'NOT_FOUND', lowPriority });
  return (info.entries || []).filter((e) => e?.id).map((e) => entryToTrack({ ...e, title: e.title || slugTitle(e.url) }, 'soundcloud'));
}

/** "https://soundcloud.com/x/world-on-fire-1" -> "World On Fire" (titles missing from flat SoundCloud entries). */
export function slugTitle(url) {
  const s = decodeURIComponent(String(url || '').split('/').filter(Boolean).pop() || '');
  return s.replace(/-\d+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'SoundCloud';
}
