// Live source tests (real network, real yt-dlp/ffmpeg): npm run test:live
// Each source: resolve() -> createStream() -> read >= 3 s of PCM. Prints resolve and first-PCM latency per source.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStream, ensureTools, resolve, search, makeTrack } from '../../src/sources/index.js';
import { createLibrary } from '../../src/sources/local.js';
import { tools } from '../../src/tools.js';

const BPS = 48000 * 2 * 2; // s16le stereo 48 kHz
const timings = [];
const WIN = process.platform === 'win32';

await ensureTools({ update: false });

/** Read until `bytes` arrive (or the stream ends), then kill. Returns {bytes, firstMs, head}. */
async function take(handle, bytes, t0) {
  let got = 0;
  let firstMs = null;
  let head = null;
  try {
    for await (const chunk of handle.stream) {
      if (firstMs === null) { firstMs = Date.now() - t0; head = chunk.subarray(0, 4); }
      got += chunk.length;
      if (got >= bytes) break;
    }
  } finally {
    handle.kill();
  }
  return { bytes: got, firstMs, head };
}

async function playCase(name, query, { seconds = 3, opts = {}, pick = 0 } = {}) {
  const t0 = Date.now();
  const r = await resolve(query, { playlistLimit: 50 });
  const resolveMs = Date.now() - t0;
  assert.ok(r.tracks.length > 0, `${name}: no tracks`);
  const track = r.tracks[pick];
  const t1 = Date.now();
  const h = await createStream(track, { mode: 'pcm', ...opts });
  assert.equal(h.type, 'raw');
  const res = await take(h, seconds * BPS, t1);
  timings.push({ name, resolveMs, firstPcmMs: res.firstMs, title: `${track.artist ?? ''} - ${track.title}`.slice(0, 60) });
  assert.ok(res.bytes >= seconds * BPS, `${name}: only ${res.bytes} bytes`);
  return { r, track, h, res };
}

/** Whole process table: [{pid, ppid, name}]. */
function procTable() {
  const out = WIN
    ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'], { encoding: 'utf8' })
    : execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1,$2,');
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, ...n] = l.trim().split(','); return { pid: +pid, ppid: +ppid, name: n.join(',') }; });
}
/** yt-dlp/ffmpeg processes descended from this test process (other agents' ffmpeg on the box don't count). */
function ourTools(table = procTable()) {
  const kids = new Map();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p]);
  const found = [];
  const walk = (pid) => { for (const c of kids.get(pid) || []) { if (c.pid === pid) continue; found.push(c); walk(c.pid); } };
  walk(process.pid);
  return found.filter((p) => /^(ffmpeg|yt-dlp)/i.test(p.name));
}
const alive = (pids, table = procTable()) => table.filter((p) => pids.includes(p.pid));

// A generated, tagged 8 s mp3 in a temp music folder (local source + exact byte-rate check).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-live-'));
const mp3 = path.join(tmp, 'Zażółć Gęślą.mp3');
execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ac', '2', '-ar', '44100',
  '-metadata', 'title=Zażółć Gęślą', '-metadata', 'artist=Testowy Artysta', '-b:a', '128k', mp3]);
const tmpLong = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-live-long-'));
const longMp3 = path.join(tmpLong, 'long.mp3'); // 120 s: its paused stream can't finish during the orphan test
execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=120', '-ac', '2', '-b:a', '64k', longMp3]);
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmpLong, { recursive: true, force: true });
  console.log('\nsource                      resolve ms  first-PCM ms  track');
  for (const t of timings) console.log(`${t.name.padEnd(28)}${String(t.resolveMs).padStart(10)}${String(t.firstPcmMs).padStart(14)}  ${t.title}`);
});

test('YouTube video (direct URL -> ffmpeg)', async () => {
  const { track } = await playCase('youtube video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(track.id, 'yt:dQw4w9WgXcQ');
  assert.ok(Math.abs(track.durationSec - 213) <= 2);
});

test('YouTube seek 60 s', async () => {
  await playCase('youtube seek 60s', 'https://youtu.be/dQw4w9WgXcQ', { opts: { seekSec: 60 } });
});

test('YouTube text search + playlist + ytsearch autocomplete', async () => {
  const { r } = await playCase('youtube text search', 'great grey wolf sif');
  assert.equal(r.tracks[0].source, 'youtube');
  const t0 = Date.now();
  const pl = await resolve('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', { playlistLimit: 30 });
  timings.push({ name: 'youtube playlist (resolve)', resolveMs: Date.now() - t0, firstPcmMs: '-', title: `${pl.playlist.title} (${pl.tracks.length})` });
  assert.equal(pl.tracks.length, 30);
  assert.ok(pl.playlist.title);
  const t1 = Date.now();
  const s = await search('never gonna give you up', { limit: 5 });
  const ms = Date.now() - t1;
  timings.push({ name: 'search() autocomplete', resolveMs: ms, firstPcmMs: '-', title: s[0]?.title ?? '(none)' });
  assert.ok(ms < 2500, `search took ${ms} ms`);
  assert.equal(s.length, 5);
  const t2 = Date.now();
  await search('never gonna give you up', { limit: 5 });
  assert.ok(Date.now() - t2 < 20, 'second search should hit the cache');
});

test('YouTube live stream (HLS)', async () => {
  const { track } = await playCase('youtube live', 'https://www.youtube.com/@LofiGirl/live');
  assert.equal(track.isLive, true);
  assert.equal(track.durationSec, null);
});

test('Spotify track -> YouTube match', async () => {
  const { track } = await playCase('spotify track->youtube', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(track.source, 'spotify');
});

test('Spotify album + playlist (embed)', async () => {
  const t0 = Date.now();
  const al = await resolve('spotify:album:4LH4d3cOWNNsVw41Gqt2kv');
  timings.push({ name: 'spotify album (resolve)', resolveMs: Date.now() - t0, firstPcmMs: '-', title: `${al.playlist.title} (${al.tracks.length})` });
  assert.equal(al.tracks.length, 10);
  const t1 = Date.now();
  const pl = await resolve('https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe');
  timings.push({ name: 'spotify playlist (resolve)', resolveMs: Date.now() - t1, firstPcmMs: '-', title: `${pl.playlist.title} (${pl.tracks.length}${pl.playlist.truncated ? ', capped' : ''})` });
  assert.ok(pl.tracks.length >= 50);
  // Stream an album track (exercises matching with a duration).
  const t2 = Date.now();
  const h = await createStream(al.tracks[1], { mode: 'pcm' });
  const res = await take(h, 3 * BPS, t2);
  timings.push({ name: 'spotify album track->yt', resolveMs: '-', firstPcmMs: res.firstMs, title: al.tracks[1].title });
  assert.ok(res.bytes >= 3 * BPS);
});

test('SoundCloud track + set', async () => {
  await playCase('soundcloud track (HLS)', 'https://soundcloud.com/forss/flickermood');
  const t0 = Date.now();
  const set = await resolve('https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep');
  timings.push({ name: 'soundcloud set (resolve)', resolveMs: Date.now() - t0, firstPcmMs: '-', title: `${set.playlist.title} (${set.tracks.length})` });
  assert.ok(set.tracks.length >= 5);
  assert.ok(set.tracks.every((t) => t.title && t.source === 'soundcloud'));
});

test('Bandcamp track', async () => {
  const { track } = await playCase('bandcamp track', 'https://c418.bandcamp.com/track/sweden');
  assert.equal(track.source, 'bandcamp');
});

test('Internet radio (icecast)', async () => {
  let res;
  try {
    res = await playCase('radio (icecast)', 'https://stream.radioparadise.com/mp3-128');
  } catch {
    res = await playCase('radio (icecast, FIP)', 'http://icecast.radiofrance.fr/fip-midfi.mp3');
  }
  assert.equal(res.track.source, 'radio');
  assert.equal(res.track.isLive, true);
});

test('Direct .mp3 URL: full decode has the exact PCM byte rate', async () => {
  const url = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
  const { track } = await playCase('direct mp3', url);
  assert.equal(track.source, 'http');
  assert.ok(track.durationSec > 300);
  const h = await createStream(track, { mode: 'pcm', seekSec: track.durationSec - 10 });
  const res = await take(h, Infinity, Date.now());
  const sec = res.bytes / BPS;
  assert.ok(sec > 8 && sec < 12, `last 10 s decoded to ${sec.toFixed(2)} s of PCM`);
});

test('Discord attachment path (resolve with {attachment}, ffmpeg over https)', async () => {
  const url = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3';
  const { tracks: [t] } = await resolve(url, { attachment: { url, name: 'My_Song.mp3', size: 1, contentType: 'audio/mpeg' } });
  assert.equal(t.source, 'attachment');
  assert.equal(t.title, 'My Song');
  assert.equal(t.streamUrl, url);
  assert.ok(t.durationSec > 60);
  const t0 = Date.now();
  const res = await take(await createStream(t, { mode: 'pcm' }), 3 * BPS, t0);
  timings.push({ name: 'attachment (https file)', resolveMs: '-', firstPcmMs: res.firstMs, title: 'SoundHelix-Song-2.mp3' });
  assert.ok(res.bytes >= 3 * BPS);
});

test('Local file: byte rate, seek, library search', async () => {
  const lib = createLibrary(tmp, path.join(tmp, 'library.json'));
  assert.equal(await lib.scan(), 1);
  const [track] = await lib.search('zazolc gesla');
  assert.equal(track.title, 'Zażółć Gęślą');
  const t0 = Date.now();
  const res = await take(await createStream(track, { mode: 'pcm' }), Infinity, t0);
  timings.push({ name: 'local file', resolveMs: '-', firstPcmMs: res.firstMs, title: track.title });
  assert.ok(Math.abs(res.bytes / BPS - 8) < 0.1, `8 s file decoded to ${(res.bytes / BPS).toFixed(3)} s`);
  const seek = await take(await createStream(track, { mode: 'pcm', seekSec: 5 }), Infinity, Date.now());
  assert.ok(Math.abs(seek.bytes / BPS - 3) < 0.1, `seek 5 s of 8 s gave ${(seek.bytes / BPS).toFixed(3)} s`);
});

test('Opus mode produces Ogg/Opus (local + YouTube), volume filter accepted', async () => {
  const local = makeTrack({ id: `local:${mp3}`, title: 'x', source: 'local', streamUrl: mp3 });
  const a = await createStream(local, { mode: 'opus', volume: 0.6 });
  assert.equal(a.type, 'ogg/opus');
  const ra = await take(a, 1, Date.now());
  assert.equal(ra.head.toString('latin1'), 'OggS');
  const yt = await resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const b = await createStream(yt.tracks[0], { mode: 'opus', volume: 1.5, seekSec: 30 });
  const rb = await take(b, 20_000, Date.now());
  assert.equal(rb.head.toString('latin1'), 'OggS');
});

test('YouTube bot check -> SoundCloud fallback (simulated bot check)', async () => {
  process.env.SOURCES_SIMULATE_BOT_CHECK = '1';
  try {
    const t = makeTrack({ id: 'yt:AAAAAAAAAAA', title: 'Forss - Flickermood (Official Audio)', artist: 'Forss', durationSec: 214, source: 'youtube', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' });
    const t0 = Date.now();
    const h = await createStream(t, { mode: 'pcm' });
    const res = await take(h, 3 * BPS, t0);
    timings.push({ name: 'bot check -> soundcloud', resolveMs: '-', firstPcmMs: res.firstMs, title: `${h.fallbackTrack.artist} - ${h.fallbackTrack.title}` });
    assert.equal(h.fallback, 'soundcloud');
    assert.equal(h.fallbackFrom, 'youtube');
    assert.equal(t.fallbackFrom, 'youtube');
    assert.equal(t.fallbackTrack.source, 'soundcloud');
    assert.ok(res.bytes >= 3 * BPS);
  } finally {
    delete process.env.SOURCES_SIMULATE_BOT_CHECK;
  }
});

test('kill() leaves no orphan yt-dlp/ffmpeg processes', async () => {
  const yt = (await resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).tracks[0];
  const local = makeTrack({ id: `local:${longMp3}`, title: 'x', source: 'local', streamUrl: longMp3 });
  const handles = [
    await createStream(yt, { mode: 'pcm' }),
    await createStream(yt, { mode: 'pcm', forcePipe: true }), // yt-dlp -o - | ffmpeg
    await createStream(local, { mode: 'opus' }),
    await createStream(makeTrack({ id: 'radio:x', title: 'r', source: 'radio', isLive: true, url: 'https://stream.radioparadise.com/mp3-128' }), { mode: 'pcm' }),
  ];
  // Streams stay paused: each process blocks on a full pipe, so all of them are alive here.
  const during = ourTools();
  const pids = during.map((p) => p.pid);
  handles[0].kill();
  handles[1].kill();
  handles[2].stream.destroy(); // consumer-side destroy must kill too
  handles[3].kill();
  handles[3].kill(); // idempotent
  await new Promise((r) => setTimeout(r, 2000));
  const left = alive(pids);
  console.log('our tool processes while streaming:', during.map((p) => `${p.name}#${p.pid}`).join(' '), '| still alive after kill:', left.length);
  assert.ok(during.filter((p) => /ffmpeg/i.test(p.name)).length >= 4, 'expected 4 ffmpeg while streaming');
  assert.ok(during.some((p) => /yt-dlp/i.test(p.name)), 'expected yt-dlp while piping');
  assert.deepEqual(left, []);
});

test('signal abort kills the pipeline', async () => {
  const ac = new AbortController();
  const local = makeTrack({ id: `local:${longMp3}`, title: 'x', source: 'local', streamUrl: longMp3 });
  const h = await createStream(local, { mode: 'pcm', signal: ac.signal });
  const pids = ourTools().map((p) => p.pid);
  assert.ok(pids.length >= 1);
  ac.abort();
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(h.stream.destroyed);
  assert.deepEqual(alive(pids), []);
});
