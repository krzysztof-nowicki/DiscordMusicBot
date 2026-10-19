// Spotify metadata (no user login) and Spotify -> YouTube matching.
//  - Web API client-credentials flow when SPOTIFY_CLIENT_ID/SECRET are set: tracks, albums (paginated). Playlist items
//    are tried via /playlists/{id}/items, but since the Feb 2026 Dev Mode changes they are only returned for playlists
//    the app user owns, so with client credentials this usually 403s and we fall back to the embed page.
//  - Public embed pages open.spotify.com/embed/{type}/{id}: __NEXT_DATA__ JSON, props.pageProps.state.data.entity.
//    Embed track lists are capped at 100 entries (playlist.truncated = true when the cap is hit).
import path from 'node:path';
import { config } from '../config.js';
import { rankCandidates, MIN_SCORE } from './match.js';
import { makeTrack, SourceError } from './track.js';
import { BROWSER_UA, fetchT, Lru, readJson, writeJson } from './util.js';
import { ytSearchCandidates } from './youtube.js';

export const EMBED_TRACK_CAP = 100;
const MAP_FILE = path.join(config.dataDir, 'spotify-map.json');
const pageUrl = (type, id) => `https://open.spotify.com/${type}/${id}`;
const idFromUri = (uri) => String(uri || '').split(':').pop();

function bigImage(images) {
  const list = (images || []).filter((i) => i?.url);
  list.sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0));
  return list[0]?.url;
}

// ---------- embed pages ----------

/** Parse an embed page's HTML into {type, title, url, thumbnail, tracks: Track[]}. Pure (fixtures in test/). */
export function parseEmbedHtml(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new SourceError('NOT_FOUND', 'spotify embed: no __NEXT_DATA__');
  const e = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!e?.type) throw new SourceError('NOT_FOUND', 'spotify embed: no entity');
  const cover = bigImage(e.visualIdentity?.image) || e.coverArt?.sources?.[0]?.url;
  const mk = (t, thumb) => makeTrack({
    id: `sp:${t.id || idFromUri(t.uri)}`,
    title: t.title || t.name,
    artist: t.artists ? t.artists.map((a) => a.name).join(', ') : t.subtitle,
    durationSec: (t.duration || 0) / 1000,
    url: pageUrl('track', t.id || idFromUri(t.uri)),
    thumbnail: thumb,
    source: 'spotify',
  });
  if (e.type === 'track') return { type: 'track', title: e.title || e.name, url: pageUrl('track', e.id), thumbnail: cover, tracks: [mk(e, cover)] };
  const tracks = (e.trackList || []).filter((t) => t.uri?.startsWith('spotify:track:') && t.isPlayable !== false)
    // Album covers apply to every track; playlist entries have no per-track art in the embed.
    .map((t) => mk(t, e.type === 'album' ? cover : undefined));
  return { type: e.type, title: e.title || e.name, subtitle: e.subtitle, url: pageUrl(e.type, e.id), thumbnail: cover, tracks, truncated: (e.trackList || []).length >= EMBED_TRACK_CAP };
}

async function fetchEmbed(type, id, signal) {
  const get = () => fetchT(`https://open.spotify.com/embed/${type}/${id}`, { timeoutMs: 10_000, signal, headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en' } });
  let res = await get();
  if (res.status >= 500) { // occasional 502/504 from Spotify's edge: one retry
    await new Promise((r) => setTimeout(r, 800));
    res = await get();
  }
  if (res.status === 404) throw new SourceError('NOT_FOUND', `spotify embed 404 ${type}/${id}`);
  if (!res.ok) throw new SourceError('NETWORK', `spotify embed HTTP ${res.status}`);
  return parseEmbedHtml(await res.text());
}

// ---------- Web API (client credentials) ----------

let token = null; // {value, exp}
async function apiToken(signal) {
  if (token && token.exp > Date.now()) return token.value;
  const { clientId, clientSecret } = config.spotify;
  const res = await fetchT('https://accounts.spotify.com/api/token', {
    method: 'POST', timeoutMs: 8000, signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`spotify token HTTP ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return token.value;
}

async function api(pathOrUrl, signal) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchT(url, { timeoutMs: 10_000, signal, headers: { authorization: `Bearer ${await apiToken(signal)}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, Math.min(5, Number(res.headers.get('retry-after')) || 1) * 1000)); continue; }
    if (res.status === 401) { token = null; continue; }
    if (!res.ok) { const err = new Error(`spotify api ${res.status} ${url}`); err.status = res.status; throw err; }
    return res.json();
  }
  throw new Error(`spotify api: retries exhausted ${url}`);
}

function apiTrack(t, albumImages) {
  return makeTrack({
    id: `sp:${t.id}`,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    durationSec: t.duration_ms / 1000,
    url: pageUrl('track', t.id),
    thumbnail: bigImage(t.album?.images || albumImages),
    source: 'spotify',
  });
}

async function apiResolve(type, id, playlistLimit, signal) {
  if (type === 'track') {
    const t = await api(`/tracks/${id}`, signal);
    return { tracks: [apiTrack(t)] };
  }
  if (type === 'album') {
    const a = await api(`/albums/${id}`, signal);
    const items = [...(a.tracks?.items || [])];
    for (let next = a.tracks?.next; next && items.length < playlistLimit; ) {
      const p = await api(next, signal);
      items.push(...p.items);
      next = p.next;
    }
    const tracks = items.slice(0, playlistLimit).map((t) => apiTrack(t, a.images));
    return { tracks, playlist: { title: `${a.name} - ${(a.artists || []).map((x) => x.name).join(', ')}`, url: pageUrl('album', id), count: tracks.length } };
  }
  if (type === 'playlist') {
    const meta = await api(`/playlists/${id}?fields=name`, signal);
    const items = [];
    for (let next = `/playlists/${id}/items?limit=50&additional_types=track`; next && items.length < playlistLimit; ) {
      const p = await api(next, signal);
      items.push(...(p.items || []));
      next = p.next;
    }
    const tracks = items.map((i) => i.item || i.track).filter((t) => t?.id && t.type !== 'episode').slice(0, playlistLimit).map((t) => apiTrack(t));
    return { tracks, playlist: { title: meta.name, url: pageUrl('playlist', id), count: tracks.length } };
  }
  throw new Error(`api: unsupported type ${type}`);
}

/**
 * Resolve Spotify track/album/playlist/artist to Spotify Tracks (matched to YouTube lazily in createStream).
 * @returns {Promise<{tracks: import('./track.js').Track[], playlist?: {title: string, url: string, count: number, truncated?: boolean}}>}
 */
export async function resolveSpotify(type, id, { playlistLimit = 500, signal } = {}) {
  if (config.spotify.clientId && config.spotify.clientSecret && type !== 'artist') {
    try {
      const r = await apiResolve(type, id, playlistLimit, signal);
      if (r.tracks.length) return r;
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[sources] spotify api ${type}/${id} failed (${e.message}); using the embed page`);
    }
  }
  const em = await fetchEmbed(type, id, signal);
  const tracks = em.tracks.slice(0, playlistLimit);
  if (!tracks.length) throw new SourceError('NOT_FOUND', `spotify ${type}/${id}: no tracks`);
  if (type === 'track') return { tracks };
  const title = type === 'album' && em.subtitle ? `${em.title} - ${em.subtitle}` : em.title;
  return { tracks, playlist: { title, url: em.url, count: tracks.length, ...(em.truncated ? { truncated: true } : {}) } };
}

/** spotify.link / *.app.link short URLs -> open.spotify.com URL. */
export async function expandShortLink(url, signal) {
  const res = await fetchT(url, { timeoutMs: 8000, signal, redirect: 'follow', headers: { 'user-agent': BROWSER_UA } });
  if (/open\.spotify\.com/.test(res.url)) return res.url;
  const m = /https:\/\/open\.spotify\.com\/[^"'\s<>]+/.exec(await res.text());
  if (!m) throw new SourceError('UNSUPPORTED', `cannot expand ${url}`);
  return m[0].replace(/&amp;/g, '&');
}

// ---------- Spotify -> YouTube ----------

let map = null; // spotifyId -> {yt, title, channel, durationSec, score, at}
let saveTimer = null;
const inflight = new Map();

async function loadMap() {
  map ??= await readJson(MAP_FILE, {});
  return map;
}
function saveMapSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(MAP_FILE, map).catch((e) => console.warn('[sources] spotify-map save:', e.message)), 1000);
  saveTimer.unref?.();
}

const searchCache = new Lru(300, 6 * 3600_000);

/**
 * Find the YouTube video for a Spotify track. Cached in data/spotify-map.json.
 * @param {import('./track.js').Track} track source 'spotify'
 * @returns {Promise<{videoId: string, title: string, channel: string, durationSec: number|null, score: number}>}
 */
export async function matchSpotifyToYoutube(track, { signal } = {}) {
  const spId = track.id.replace(/^sp:/, '');
  const m = await loadMap();
  if (m[spId]) return { videoId: m[spId].yt, ...m[spId] };
  if (inflight.has(spId)) return inflight.get(spId);
  const p = (async () => {
    const firstArtist = (track.artist || '').split(',')[0].trim();
    const want = { title: track.title, artist: track.artist || '', durationSec: track.durationSec };
    const queries = [`${firstArtist} - ${track.title}`, `${firstArtist} ${track.title} audio`];
    let best = null;
    for (const q of queries) {
      let cands = searchCache.get(q);
      if (!cands) cands = searchCache.set(q, await ytSearchCandidates(q, 10, { signal }));
      const ranked = rankCandidates(cands, want);
      if (ranked[0] && (!best || ranked[0].score > best.score)) best = ranked[0];
      if (best && best.score >= 70) break; // good enough: duration + title + artist agree
    }
    if (!best || best.score < MIN_SCORE) throw new SourceError('NO_MATCH', `no YouTube match for "${track.artist} - ${track.title}" (best ${best?.score})`);
    const entry = { yt: best.cand.id, title: best.cand.title, channel: best.cand.channel, durationSec: best.cand.durationSec, score: best.score, at: Date.now() };
    m[spId] = entry;
    saveMapSoon();
    return { videoId: entry.yt, ...entry };
  })();
  inflight.set(spId, p);
  try { return await p; } finally { inflight.delete(spId); }
}
