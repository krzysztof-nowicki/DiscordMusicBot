// createStream: any Track -> audio for @discordjs/voice.
//   AUDIO_MODE=pcm  -> s16le 48 kHz stereo        (type 'raw',       player uses StreamType.Raw + inlineVolume)
//   AUDIO_MODE=opus -> Ogg/Opus 96k from ffmpeg   (type 'ogg/opus',  StreamType.OggOpus, no re-encode in Node;
//                                                  volume is baked in with ffmpeg's volume filter)
// Inputs:
//   local / http / radio / attachment:  ffmpeg -i <file|url>
//   youtube / soundcloud / bandcamp / generic / spotify(->youtube match):
//     direct: yt-dlp -j (cached until the signed URL expires) -> ffmpeg -ss N -reconnect ... -i <media url>
//     pipe:   yt-dlp -o - | ffmpeg -i pipe:0   (protocols ffmpeg can't open itself, e.g. DASH segments)
//   YouTube bot check ("confirm you're not a bot") -> SoundCloud match when YT_FALLBACK=soundcloud.
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { config } from '../config.js';
import { ensureTools, killTree, spawnTool, tools, ytdlpBaseArgs, ytdlpProfile } from '../tools.js';
import { MIN_SCORE, rankCandidates } from './match.js';
import { matchSpotifyToYoutube } from './spotify.js';
import { isAllowedLocalFile } from './local.js';
import { SourceError, throwIfAborted } from './track.js';
import { Lru } from './util.js';
import { soundcloudSearch, ytdlpStreamInfo } from './ytdlp.js';

const FIRST_DATA_TIMEOUT_MS = 30_000;
const DIRECT_PROTOCOLS = new Set(['http', 'https', 'm3u8', 'm3u8_native']);
const infoCache = new Lru(200); // entries also carry expiresAt (signed URL expiry)
const inflight = new Map();
const fallbackCache = new Lru(500, 6 * 3600_000);

/** Page URL yt-dlp should open for a track (Spotify tracks are matched to YouTube first). */
async function pageUrlFor(track, signal) {
  if (track.source === 'spotify') {
    const m = await matchSpotifyToYoutube(track, { signal });
    return `https://www.youtube.com/watch?v=${m.videoId}`;
  }
  return track.streamUrl || track.url;
}

async function fetchInfo(pageUrl, signal) {
  if (inflight.has(pageUrl)) return inflight.get(pageUrl);
  const p = ytdlpStreamInfo(pageUrl, { signal }).then((i) => {
    const { info, ...keep } = i; // the cache holds only what streaming needs
    infoCache.set(pageUrl, keep);
    return i;
  });
  inflight.set(pageUrl, p);
  try { return await p; } finally { inflight.delete(pageUrl); }
}

/** Cached direct stream info for a page URL (re-resolved when the signed URL is about to expire). */
async function streamInfo(pageUrl, { signal, fresh = false } = {}) {
  const c = !fresh && infoCache.get(pageUrl);
  if (c && c.expiresAt > Date.now()) return c;
  const { info, ...keep } = await fetchInfo(pageUrl, signal);
  return keep;
}

/**
 * Used by resolve(): full yt-dlp info dict for a single page, caching the stream URL so the first play is fast.
 * @returns {Promise<object>} yt-dlp info dict
 */
export async function primeStreamInfo(pageUrl, { signal } = {}) {
  return (await fetchInfo(pageUrl, signal)).info;
}
/** Make `alias` (e.g. the canonical track URL) share the cached stream info of `pageUrl`. */
primeStreamInfo.alias = (alias, pageUrl) => {
  const c = infoCache.get(pageUrl);
  if (c && alias && alias !== pageUrl) infoCache.set(alias, c);
};

const isYtdlpSource = (t) => ['youtube', 'soundcloud', 'bandcamp', 'generic', 'spotify'].includes(t.source);

function localPath(track) {
  if (track.streamUrl) return track.streamUrl;
  const rel = track.id.replace(/^local:/, '');
  return path.isAbsolute(rel) ? rel : path.join(config.musicDir, ...rel.split('/'));
}

/** ffmpeg arguments for one input -> PCM or Ogg/Opus on stdout. Exported for tests. */
export function ffmpegArgs({ input, headers, seekSec = 0, network = false, endless = false, loudnorm = false, mode = 'pcm', volume = 1 }) {
  // Low CPU: one thread, modest probing (inputs are plain audio), no loudnorm unless asked.
  const a = ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-probesize', '512k', '-analyzeduration', '2000000'];
  if (input !== 'pipe:0') a.push('-nostdin');
  if (network) {
    a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    // Endless icecast-style streams only: on HLS this would re-fetch the playlist forever instead of reading it.
    if (endless && !/\.m3u8?(\?|$)|\/hls_playlist\/|manifest/i.test(input)) a.push('-reconnect_at_eof', '1');
    const h = { ...(headers || {}) };
    const ua = h['User-Agent'] || h['user-agent'];
    delete h['User-Agent'];
    delete h['user-agent'];
    if (ua) a.push('-user_agent', ua);
    const extra = Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    if (extra) a.push('-headers', extra);
  }
  if (seekSec > 0) a.push('-ss', String(seekSec));
  a.push('-i', input, '-vn', '-sn', '-dn');
  const filters = [];
  if (loudnorm) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  const gain = volume > 5 ? volume / 100 : volume; // a factor (0.6 = 60 %); tolerate percent values too
  if (mode === 'opus' && Number.isFinite(gain) && Math.abs(gain - 1) > 0.001) filters.push(`volume=${Math.max(0, gain).toFixed(3)}`);
  if (filters.length) a.push('-af', filters.join(','), '-filter_threads', '1');
  a.push('-threads', '1', '-ar', '48000', '-ac', '2');
  if (mode === 'opus') a.push('-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on', '-frame_duration', '20', '-application', 'audio', '-f', 'ogg', 'pipe:1');
  else a.push('-f', 's16le', 'pipe:1');
  return a;
}

function classifyFfmpegError(stderr) {
  if (/403|Forbidden|410 Gone/i.test(stderr)) return 'EXPIRED';
  if (/404|No such file|does not exist/i.test(stderr)) return 'UNAVAILABLE';
  if (/timed out|Connection refused|resolve|I\/O error|Network is unreachable/i.test(stderr)) return 'NETWORK';
  return 'STREAM_FAILED';
}

/**
 * Spawn the pipeline and wait for the first output bytes, so failures surface here as a SourceError instead of
 * as an empty stream later. Resolves {stream, kill}.
 */
function startPipeline({ ffArgs, ytdlpArgs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SourceError('ABORTED', 'aborted before spawn'));
    const procs = [];
    let ytdlp = null;
    if (ytdlpArgs) {
      ytdlp = spawnTool(tools.ytdlp, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      procs.push(ytdlp);
    }
    const ff = spawnTool(tools.ffmpeg, ffArgs, { stdio: [ytdlp ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    procs.push(ff);
    let stderr = '';
    const addErr = (d) => { stderr = (stderr + d).slice(-4000); };
    ff.stderr.on('data', addErr);
    if (ytdlp) {
      ytdlp.stderr.on('data', addErr);
      ytdlp.stdout.pipe(ff.stdin);
      ytdlp.stdout.on('error', () => {});
      ff.stdin.on('error', () => {}); // EPIPE when ffmpeg exits first
    }
    // What the caller gets: a PassThrough fed from ffmpeg's stdout once audio has started. It is never explicitly
    // paused, so every consumer style works (pipe, for-await, and a plain on('data'), which would never resume a
    // stream left explicitly paused by pause() + unshift()).
    const src = ff.stdout;
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    let killed = false;
    let started = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      signal?.removeEventListener('abort', onAbort);
      for (const p of procs) killTree(p);
      if (!src.destroyed) src.destroy();
      if (!stream.destroyed) stream.destroy();
    };
    const fail = (err) => { clearTimeout(timer); kill(); reject(err); };
    const onAbort = () => (started ? kill() : fail(new SourceError('ABORTED', 'aborted while starting')));
    const timer = setTimeout(() => fail(new SourceError('NETWORK', `no audio after ${FIRST_DATA_TIMEOUT_MS} ms: ${stderr.trim()}`)), FIRST_DATA_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });

    for (const p of procs) p.on('error', (e) => (started ? kill() : fail(new SourceError('TOOL_MISSING', e.message))));
    src.once('data', (chunk) => {
      started = true;
      clearTimeout(timer);
      stream.write(chunk);
      src.pipe(stream); // backpressure: src pauses while the PassThrough is full
      src.once('error', () => kill());
      resolve({ stream, kill });
    });
    ff.on('close', (code) => {
      if (ytdlp) killTree(ytdlp);
      if (!started) {
        const kind = classifyFfmpegError(stderr);
        const err = /not a bot|rate-limited by YouTube/i.test(stderr)
          ? new SourceError('BOT_CHECK', stderr.trim().slice(-500))
          : new SourceError(kind === 'EXPIRED' ? 'STREAM_FAILED' : kind, `ffmpeg exited ${code} before audio: ${stderr.trim().slice(-500)}`);
        fail(err);
      } else if (code && !killed) {
        console.warn(`[sources] ffmpeg exited ${code}: ${stderr.trim().slice(-300)}`);
      }
    });
    // The consumer destroyed the stream (skip/stop): kill the processes too.
    stream.once('close', () => { if (started) kill(); });
  });
}

async function ytdlpSourceStream(track, { seek, signal, out }) {
  const pageUrl = await pageUrlFor(track, signal);
  if (!pageUrl) throw new SourceError('UNSUPPORTED', `no url for ${track.id}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(signal);
    const info = await streamInfo(pageUrl, { signal, fresh: attempt > 0 });
    throwIfAborted(signal);
    if (out.forcePipe || !DIRECT_PROTOCOLS.has(String(info.protocol).split('+')[0])) {
      // Pipe mode: yt-dlp downloads, ffmpeg decodes stdin.
      const ytdlpArgs = [...ytdlpBaseArgs(), '-f', ytdlpProfile.format, '--no-playlist', '--quiet', '-o', '-', '--', pageUrl];
      return startPipeline({ ffArgs: ffmpegArgs({ ...out, input: 'pipe:0', seekSec: seek }), ytdlpArgs, signal });
    }
    try {
      return await startPipeline({
        ffArgs: ffmpegArgs({ ...out, input: info.url, headers: info.headers, network: true, seekSec: info.isLive ? 0 : seek }),
        signal,
      });
    } catch (e) {
      infoCache.delete(pageUrl);
      if (attempt === 0 && !signal?.aborted && e.code !== 'TOOL_MISSING' && e.code !== 'ABORTED') continue; // expired/flaky URL: re-resolve once
      throw e;
    }
  }
  throw new SourceError('STREAM_FAILED', pageUrl);
}

/** "Artist - Title (Official Video)" -> {artist, title} for a cross-site search. */
export function songOf(track) {
  if (track.source === 'spotify') return { artist: (track.artist || '').split(',')[0].trim(), title: track.title };
  const clean = track.title.replace(/[([][^)\]]*(official|video|audio|lyric|remaster|hd|4k|mv)[^)\]]*[)\]]/gi, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: track.artist || '', title: clean };
}

/** Best SoundCloud match for a track YouTube refused (null if nothing is close enough). */
async function soundcloudFallback(track, signal) {
  const hit = fallbackCache.get(track.id);
  if (hit) return hit;
  const { artist, title } = songOf(track);
  const cands = await soundcloudSearch(`${artist} ${title}`.trim(), 8, signal);
  const ranked = rankCandidates(cands.map((t) => ({ ...t, channel: t.artist })), { title, artist, durationSec: track.durationSec });
  const best = ranked[0];
  if (!best || best.score < MIN_SCORE) return null;
  const { channel, ...sc } = best.cand;
  return fallbackCache.set(track.id, sc);
}

/**
 * @param {import('./track.js').Track} track
 * @param {{seekSec?: number, volume?: number, signal?: AbortSignal, loudnorm?: boolean, mode?: 'pcm'|'opus', forcePipe?: boolean}} [opts]
 *   volume: factor (1 = unchanged, 0.6 = 60 %). Applied by ffmpeg only for ogg/opus output; raw output ignores it
 *   (the player uses inlineVolume).
 *   forcePipe: always use yt-dlp -o - | ffmpeg (tests/debugging).
 * @returns {Promise<{stream: import('node:stream').Readable, type: 'raw'|'ogg/opus', kill: () => void,
 *                    fallback?: 'soundcloud', fallbackFrom?: 'youtube', fallbackTrack?: import('./track.js').Track}>}
 */
export async function createStream(track, { seekSec = 0, volume = 1, signal, loudnorm = false, mode = config.audioMode, forcePipe = false } = {}) {
  throwIfAborted(signal);
  // Only audio files inside MUSIC_DIR (realpath, no UNC): a crafted or persisted Track can't open other files.
  const file = track.source === 'local' ? localPath(track) : null;
  if (file && !(isAllowedLocalFile(file) && fs.existsSync(file))) throw new SourceError('LOCAL_MISSING', file);
  try {
    await ensureTools();
  } catch (e) {
    throw new SourceError('TOOL_MISSING', e.message);
  }
  throwIfAborted(signal);
  const seek = track.isLive ? 0 : Math.max(0, Math.floor(seekSec || 0));
  const out = { mode, volume, loudnorm, forcePipe };
  const type = mode === 'opus' ? 'ogg/opus' : 'raw';

  if (track.source === 'local') {
    return { ...(await startPipeline({ ffArgs: ffmpegArgs({ ...out, input: file, seekSec: seek }), signal })), type };
  }
  if (['http', 'radio', 'attachment'].includes(track.source)) {
    const url = track.streamUrl || track.url;
    const endless = track.source === 'radio' || track.isLive;
    const ffArgs = ffmpegArgs({ ...out, input: url, network: true, endless, seekSec: seek, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return { ...(await startPipeline({ ffArgs, signal })), type };
  }
  if (!isYtdlpSource(track)) throw new SourceError('UNSUPPORTED', `source ${track.source}`);

  try {
    return { ...(await ytdlpSourceStream(track, { seek, signal, out })), type };
  } catch (e) {
    const yt = track.source === 'youtube' || track.source === 'spotify';
    if (!(yt && e.code === 'BOT_CHECK' && config.ytFallback === 'soundcloud') || signal?.aborted) throw e;
    throwIfAborted(signal);
    console.warn(`[sources] YouTube bot check for ${track.id}; trying SoundCloud`);
    const sc = await soundcloudFallback(track, signal).catch(() => null);
    if (!sc) throw e;
    const h = await ytdlpSourceStream(sc, { seek, signal, out });
    Object.assign(track, { fallback: 'soundcloud', fallbackFrom: 'youtube', fallbackTrack: sc });
    return { ...h, type, fallback: 'soundcloud', fallbackFrom: 'youtube', fallbackTrack: sc };
  }
}

/** Warm caches (Spotify match, direct URL). Never throws. */
export async function prefetch(track) {
  try {
    if (!track || !isYtdlpSource(track) || track.isLive || track.fallback) return;
    await ensureTools();
    const pageUrl = await pageUrlFor(track);
    if (pageUrl) await streamInfo(pageUrl);
  } catch (e) {
    console.warn(`[sources] prefetch ${track?.id}: ${e.detail || e.message}`);
  }
}
