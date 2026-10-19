// Offline source tests: URL detection, Spotify embed parsing, innertube parsing, match scoring, ffmpeg args,
// local library fuzzy search on generated tagged mp3s (needs ffmpeg on PATH or FFMPEG_PATH; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from '../src/sources/detect.js';
import { parseEmbedHtml } from '../src/sources/spotify.js';
import { parseInnertubeSearch, candToTrack } from '../src/sources/youtube.js';
import { rankCandidates, scoreCandidate, MIN_SCORE } from '../src/sources/match.js';
import { ffmpegArgs, songOf } from '../src/sources/stream.js';
import { parseRadioPlaylist } from '../src/sources/resolve.js';
import { createLibrary } from '../src/sources/local.js';
import { entryToTrack, ytdlpError, slugTitle } from '../src/sources/ytdlp.js';
import { makeTrack, SourceError } from '../src/sources/track.js';
import { norm, Lru, tokenCoverage } from '../src/sources/util.js';
import { config } from '../src/config.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

test('detect: YouTube URL forms', () => {
  assert.deepEqual(detect('https://youtu.be/dQw4w9WgXcQ?t=10'), { kind: 'youtube', type: 'video', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(detect('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123').type, 'video');
  assert.equal(detect('https://music.youtube.com/watch?v=dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
  assert.equal(detect('https://m.youtube.com/shorts/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
  assert.equal(detect('https://www.youtube.com/live/jfKfPfyJRdk').id, 'jfKfPfyJRdk');
  assert.deepEqual(detect('https://www.youtube.com/playlist?list=PLabc'), { kind: 'youtube', type: 'playlist', id: 'PLabc', url: 'https://www.youtube.com/playlist?list=PLabc' });
  assert.equal(detect('https://www.youtube.com/@LofiGirl/live').type, 'other');
  assert.equal(detect('<https://youtu.be/dQw4w9WgXcQ>').id, 'dQw4w9WgXcQ'); // Discord no-embed syntax
});

test('detect: Spotify, SoundCloud, Bandcamp, attachments, radio, prefixes, local, text', () => {
  assert.deepEqual(detect('https://open.spotify.com/intl-pl/track/4uLU6hMCjMI75M1A2tKUQC?si=x'), { kind: 'spotify', type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });
  assert.deepEqual(detect('spotify:album:4LH4d3cOWNNsVw41Gqt2kv'), { kind: 'spotify', type: 'album', id: '4LH4d3cOWNNsVw41Gqt2kv' });
  assert.equal(detect('https://open.spotify.com/embed/playlist/37i9dQZF1DX4UtSsGT1Sbe').type, 'playlist');
  assert.equal(detect('https://spotify.link/AbCdEf').kind, 'spotify-short');
  assert.deepEqual(detect('https://soundcloud.com/forss/flickermood'), { kind: 'soundcloud', type: 'track', url: 'https://soundcloud.com/forss/flickermood' });
  assert.equal(detect('https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep').type, 'playlist');
  assert.equal(detect('https://c418.bandcamp.com/track/sweden').type, 'track');
  assert.equal(detect('https://c418.bandcamp.com/album/minecraft-volume-alpha').type, 'playlist');
  assert.equal(detect('https://cdn.discordapp.com/attachments/1/2/song.mp3?ex=1&is=2&hm=3').kind, 'attachment');
  assert.equal(detect('https://stream.radioparadise.com/mp3-128').kind, 'url');
  assert.deepEqual(detect('sc: daft punk'), { kind: 'search', source: 'soundcloud', q: 'daft punk' });
  assert.equal(detect('yt:dQw4w9WgXcQ').type, 'video');
  assert.deepEqual(detect('yt: hello world'), { kind: 'search', source: 'youtube', q: 'hello world' });
  assert.deepEqual(detect('local: wilk sif'), { kind: 'local', q: 'wilk sif' });
  assert.equal(detect('sp:4uLU6hMCjMI75M1A2tKUQC').type, 'track');
  if (process.platform === 'win32') assert.equal(detect('C:\\Music\\a.mp3').kind, 'local');
  assert.deepEqual(detect('rick astley never gonna'), { kind: 'search', source: 'youtube', q: 'rick astley never gonna' });
});

test('Spotify embed parsing: track, album, playlist fixtures', () => {
  const t = parseEmbedHtml(fixture('spotify-embed-track.html'));
  assert.equal(t.type, 'track');
  assert.deepEqual(t.tracks[0], {
    id: 'sp:4uLU6hMCjMI75M1A2tKUQC', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 214,
    url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', thumbnail: t.thumbnail, source: 'spotify', isLive: false,
  });
  assert.match(t.thumbnail, /^https:\/\/image-cdn-.*ab67616d0000b273/); // the 640px cover

  const a = parseEmbedHtml(fixture('spotify-embed-album.html'));
  assert.equal(a.type, 'album');
  assert.equal(a.title, 'The Dark Side of the Moon');
  assert.equal(a.subtitle, 'Pink Floyd');
  assert.equal(a.tracks.length, 10);
  assert.equal(a.tracks[1].title, 'Breathe (In the Air)');
  assert.equal(a.tracks[1].artist, 'Pink Floyd');
  assert.ok(a.tracks.every((x) => x.thumbnail === a.thumbnail && x.durationSec > 0));

  const p = parseEmbedHtml(fixture('spotify-embed-playlist.html'));
  assert.equal(p.type, 'playlist');
  assert.equal(p.title, 'Today’s Top Hits');
  assert.equal(p.tracks.length, 50);
  assert.equal(p.truncated, false);
  assert.equal(p.tracks[0].artist, 'Olivia Rodrigo, Chappell Roan');
  assert.throws(() => parseEmbedHtml('<html></html>'), SourceError);
});

test('innertube search parsing', () => {
  const c = parseInnertubeSearch(JSON.parse(fixture('innertube-search.json')));
  assert.equal(c.length, 7);
  assert.deepEqual(c[0], { id: 'Fg_AkYeZcNM', title: 'Great Grey Wolf Sif', channel: 'Motoi Sakuraba - Topic', durationSec: 203, isLive: false, verifiedArtist: false });
  assert.equal(c[4].durationSec, 31 * 60 + 51);
  assert.equal(c[6].isLive, true);
  assert.equal(c[6].durationSec, null);
  const t = candToTrack(c[0]);
  assert.equal(t.artist, 'Motoi Sakuraba');
  assert.equal(t.thumbnail, 'https://i.ytimg.com/vi/Fg_AkYeZcNM/hqdefault.jpg');
});

test('match scoring: Topic/official within ±7 s beats live, cover and wrong-length uploads', () => {
  const want = { title: 'Breathe (In the Air)', artist: 'Pink Floyd', durationSec: 170 };
  const cands = [
    { id: 'live', title: 'Pink Floyd - Breathe (Live at Pompeii)', channel: 'Pink Floyd', durationSec: 200 },
    { id: 'cover', title: 'Breathe (In the Air) - Pink Floyd cover', channel: 'Guitar Guy', durationSec: 171 },
    { id: 'remaster', title: 'Pink Floyd - Breathe (In The Air) (2023 Remaster)', channel: 'Pink Floyd', durationSec: 167 },
    { id: 'topic', title: 'Breathe (In the Air)', channel: 'Pink Floyd - Topic', durationSec: 169 },
    { id: 'hour', title: 'Pink Floyd - Breathe 1 hour loop', channel: 'Loops', durationSec: 3600 },
    { id: 'other', title: 'Pink Floyd - Time', channel: 'Pink Floyd', durationSec: 170 },
  ];
  const ranked = rankCandidates(cands, want).map((r) => r.cand.id);
  assert.deepEqual(ranked.slice(0, 2), ['topic', 'remaster']);
  for (const id of ['live', 'hour', 'other']) assert.ok(scoreCandidate(cands.find((c) => c.id === id), want) < MIN_SCORE, id);
  assert.ok(ranked.indexOf('cover') > ranked.indexOf('remaster'));
  // Same video, only the duration differs: inside the tolerance scores higher than 30 s off.
  const base = { title: 'Pink Floyd - Breathe (In The Air)', channel: 'Pink Floyd' };
  assert.ok(scoreCandidate({ ...base, durationSec: 176 }, want) > scoreCandidate({ ...base, durationSec: 200 }, want));
  // "Live" is fine when the wanted title says live.
  assert.ok(scoreCandidate(cands[0], { ...want, title: 'Breathe (Live at Pompeii)', durationSec: 200 }) >= MIN_SCORE);
});

test('text helpers: accent folding, coverage, LRU', () => {
  assert.equal(norm('Zażółć Gęślą Jaźń — Łódź!'), 'zazolc gesla jazn lodz');
  assert.equal(norm('Ærøskøbing Straße'), 'aeroskobing strasse');
  assert.equal(tokenCoverage('great grey wolf', 'Great Gray Wolf Sif'), (1 + 0.8 + 1) / 3);
  const l = new Lru(2);
  l.set('a', 1); l.set('b', 2); l.get('a'); l.set('c', 3);
  assert.equal(l.get('b'), undefined);
  assert.equal(l.get('a'), 1);
});

test('ffmpeg args: pcm vs opus, volume only for opus, low-CPU flags, reconnect rules', () => {
  const pcm = ffmpegArgs({ input: 'a.mp3', mode: 'pcm', volume: 0.6 });
  assert.ok(pcm.join(' ').endsWith('-f s16le pipe:1'));
  assert.ok(!pcm.includes('-af'));
  assert.ok(pcm.includes('-threads'));
  const opus = ffmpegArgs({ input: 'a.mp3', mode: 'opus', volume: 0.6, seekSec: 42 });
  const s = opus.join(' ');
  assert.match(s, /-ss 42 -i a\.mp3/);
  assert.match(s, /-af volume=0\.600/);
  assert.match(s, /-c:a libopus -b:a 96k -vbr on -frame_duration 20 -application audio -f ogg pipe:1$/);
  assert.ok(!ffmpegArgs({ input: 'a.mp3', mode: 'opus', volume: 1 }).includes('-af'));
  assert.match(ffmpegArgs({ input: 'a.mp3', mode: 'opus', volume: 150 }).join(' '), /volume=1\.500/); // percent tolerated
  const radio = ffmpegArgs({ input: 'https://x/stream', network: true, endless: true, headers: { 'User-Agent': 'UA', Referer: 'r' } }).join(' ');
  assert.match(radio, /-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -reconnect_at_eof 1 -user_agent UA -headers Referer: r\r\n/);
  const hls = ffmpegArgs({ input: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8', network: true, endless: true }).join(' ');
  assert.ok(!hls.includes('reconnect_at_eof'));
  assert.ok(ffmpegArgs({ input: 'x', loudnorm: true }).join(' ').includes('loudnorm'));
});

test('radio playlists, yt-dlp error mapping, entry mapping, songOf', () => {
  assert.equal(parseRadioPlaylist('[playlist]\nNumberOfEntries=1\nFile1=http://ice.example/stream\nTitle1=X'), 'http://ice.example/stream');
  assert.equal(parseRadioPlaylist('#EXTM3U\n#EXTINF:-1,Radio\nhttps://r.example/live.mp3\n'), 'https://r.example/live.mp3');
  assert.equal(ytdlpError("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies").code, 'BOT_CHECK');
  assert.equal(ytdlpError('ERROR: [youtube] abc: Sign in to confirm your age.').code, 'AGE_RESTRICTED');
  assert.equal(ytdlpError('ERROR: [youtube] abc: Video unavailable. This video is private').code, 'UNAVAILABLE');
  assert.equal(ytdlpError('ERROR: Unsupported URL: https://example.com').code, 'UNSUPPORTED');
  const t = entryToTrack({ id: 'dQw4w9WgXcQ', title: 'Never Gonna', channel: 'Rick Astley', duration: 213.2, extractor_key: 'Youtube' });
  assert.equal(t.id, 'yt:dQw4w9WgXcQ');
  assert.equal(t.durationSec, 213);
  const sc = entryToTrack({ id: '293', title: 'Flickermood', uploader: 'Forss', duration: 213.9, webpage_url: 'https://soundcloud.com/forss/flickermood', extractor_key: 'Soundcloud' });
  assert.equal(sc.id, 'sc:293');
  assert.equal(sc.source, 'soundcloud');
  assert.equal(entryToTrack({ id: 'x', title: 'Live', is_live: true, extractor_key: 'Twitch', url: 'https://twitch.tv/x' }).durationSec, null);
  assert.equal(slugTitle('https://soundcloud.com/x/world-on-fire-1'), 'World On Fire');
  assert.deepEqual(songOf(makeTrack({ id: 'yt:x', title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', source: 'youtube' })), { artist: 'Rick Astley', title: 'Never Gonna Give You Up' });
  assert.deepEqual(songOf(makeTrack({ id: 'sp:x', title: 'Breathe', artist: 'Pink Floyd, Other', source: 'spotify' })), { artist: 'Pink Floyd', title: 'Breathe' });
  const err = new SourceError('BOT_CHECK', 'detail');
  assert.equal(err.code, 'BOT_CHECK');
  assert.equal(err.userMessage, err.message);
  assert.match(err.message, config.lang === 'en' ? /YouTube is blocking/ : /YouTube blokuje/);
});

test('local library: recursive scan of tagged files, accent-insensitive fuzzy search, folders, rescan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-lib-'));
  const gen = (rel, meta = {}) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const m = Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    execFileSync(config.ffmpegPath || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=2', '-ac', '2', ...m, '-b:a', '64k', f]);
    return f;
  };
  try {
    gen('Polskie/01. Łódź nocą.mp3', { title: 'Łódź Nocą', artist: 'Kapela Żółta', album: 'Miasto', track: '1' });
    gen('Polskie/02. Wrocław.mp3', { title: 'Wrocław o świcie', artist: 'Kapela Żółta', album: 'Miasto', track: '2' });
    gen('Dark Souls/12. Great Grey Wolf Sif.mp3', { title: 'Great Grey Wolf Sif', artist: 'Motoi Sakuraba', track: '12' });
    gen('03 - Hello_World.mp3'); // untagged: title from the file name
    fs.writeFileSync(path.join(root, 'notes.txt'), 'not audio');
    const index = path.join(root, '.index', 'library.json');
    const lib = createLibrary(root, index);
    assert.equal(await lib.scan(), 4);
    assert.ok(fs.existsSync(index));

    const first = async (q) => (await lib.search(q, 3))[0]?.title;
    assert.equal(await first('lodz'), 'Łódź Nocą');
    assert.equal(await first('ŁÓDŹ NOCĄ'), 'Łódź Nocą');
    assert.equal(await first('wroclaw swicie'), 'Wrocław o świcie');
    assert.equal(await first('gray wolf'), 'Great Grey Wolf Sif'); // 1 typo
    assert.equal(await first('sakuraba'), 'Great Grey Wolf Sif'); // artist
    assert.equal(await first('hello world'), 'Hello World');
    assert.equal((await lib.search('zolta', 5)).length, 2); // both songs by "Kapela Żółta"
    assert.deepEqual(await lib.search('xyzzy'), []);
    const sif = (await lib.search('sif'))[0];
    assert.equal(sif.id, 'local:Dark Souls/12. Great Grey Wolf Sif.mp3');
    assert.equal(sif.source, 'local');
    assert.equal(sif.durationSec, 2);
    assert.equal(sif.streamUrl, path.join(root, 'Dark Souls', '12. Great Grey Wolf Sif.mp3'));

    const top = await lib.list('');
    assert.deepEqual(top.dirs, ['Dark Souls', 'Polskie']);
    assert.deepEqual(top.tracks.map((t) => t.title), ['Hello World']);
    const pl = await lib.list('Polskie');
    assert.deepEqual(pl.tracks.map((t) => t.title), ['Łódź Nocą', 'Wrocław o świcie']); // track-number order
    assert.equal((await lib.list('', { recursive: true })).tracks.length, 4);
    assert.deepEqual((await lib.list('../..')).tracks, []);
    assert.equal((await lib.get('Polskie/02. Wrocław.mp3')).title, 'Wrocław o świcie');

    // Changed file (new mtime/size) is re-read; a fresh instance reuses the cached index.
    gen('Polskie/02. Wrocław.mp3', { title: 'Wrocław nocą', artist: 'Kapela Żółta', track: '2' });
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'Polskie', '02. Wrocław.mp3'), t, t);
    await lib.scan();
    assert.equal(await first('wroclaw'), 'Wrocław nocą');
    const lib2 = createLibrary(root, index);
    assert.equal(await lib2.scan(), 4);
    assert.equal((await lib2.search('wroclaw'))[0].title, 'Wrocław nocą');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
