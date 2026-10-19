// YouTube search: innertube /youtubei/v1/search (~0.5 s) with yt-dlp "ytsearchN:" (~2 s) as the fallback.
import { makeTrack } from './track.js';
import { BROWSER_UA, fetchT, parseClock } from './util.js';
import { ytdlpJson } from './ytdlp.js';

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const CLIENT = { clientName: 'WEB', clientVersion: '2.20261015.00.00', hl: 'en', gl: 'US' };
const VIDEOS_ONLY = 'EgIQAQ%3D%3D'; // search filter: type = video

/** @typedef {{id: string, title: string, channel: string, durationSec: number|null, isLive: boolean, verifiedArtist?: boolean}} YtCandidate */

const text = (t) => t?.simpleText ?? (t?.runs || []).map((r) => r.text).join('') ?? '';

/** Extract video candidates from an innertube search response. Pure (tested with a fixture). */
export function parseInnertubeSearch(json) {
  const out = [];
  const seen = new Set();
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const v = o.videoRenderer;
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      const badges = [...(v.badges || []), ...(v.ownerBadges || [])].map((b) => b.metadataBadgeRenderer?.style || '');
      const overlayLive = (v.thumbnailOverlays || []).some((x) => x.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE');
      const durationSec = parseClock(v.lengthText?.simpleText);
      const isLive = badges.includes('BADGE_STYLE_TYPE_LIVE_NOW') || overlayLive || durationSec == null;
      out.push({
        id: v.videoId,
        title: text(v.title),
        channel: text(v.ownerText || v.longBylineText),
        durationSec: isLive ? null : durationSec,
        isLive,
        verifiedArtist: badges.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST'),
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(json);
  return out;
}

async function innertube(q, { signal, timeoutMs = 2000 } = {}) {
  const res = await fetchT(INNERTUBE_URL, {
    method: 'POST',
    timeoutMs,
    signal,
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA, 'accept-language': 'en' },
    body: JSON.stringify({ context: { client: CLIENT }, query: q, params: decodeURIComponent(VIDEOS_ONLY) }),
  });
  if (!res.ok) throw new Error(`innertube HTTP ${res.status}`);
  return parseInnertubeSearch(await res.json());
}

async function ytdlpSearch(q, limit, { signal, lowPriority = false } = {}) {
  const info = await ytdlpJson(['--flat-playlist', '-J', `ytsearch${limit}:${q}`], { timeoutMs: 20_000, signal, errCode: 'NOT_FOUND', lowPriority });
  return (info.entries || []).filter((e) => e?.id).map((e) => {
    const isLive = e.live_status === 'is_live';
    return { id: e.id, title: e.title || e.id, channel: e.channel || e.uploader || '', durationSec: isLive ? null : e.duration ?? null, isLive };
  });
}

/**
 * Search YouTube videos. Innertube first, yt-dlp if that fails or returns nothing.
 * @returns {Promise<YtCandidate[]>}
 */
export async function ytSearchCandidates(q, limit = 10, { signal, fast = false } = {}) {
  try {
    const r = await innertube(q, { signal, timeoutMs: fast ? 1800 : 4000 });
    if (r.length) return r.slice(0, limit);
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[sources] innertube search failed, falling back to yt-dlp:', e.message);
  }
  return (await ytdlpSearch(q, limit, { signal, lowPriority: fast })).slice(0, limit);
}

/** @param {YtCandidate} c */
export function candToTrack(c) {
  return makeTrack({
    id: `yt:${c.id}`,
    title: c.title,
    artist: c.channel ? c.channel.replace(/ - Topic$/, '') : undefined,
    durationSec: c.durationSec,
    url: `https://www.youtube.com/watch?v=${c.id}`,
    thumbnail: `https://i.ytimg.com/vi/${c.id}/hqdefault.jpg`,
    source: 'youtube',
    isLive: c.isLive,
  });
}
