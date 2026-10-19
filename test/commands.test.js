// Command handlers with mocked interactions, a real PlayerManager/GuildPlayer and fake voice + sources.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { setLang } from '../src/ui/i18n.js';
import { setDataDir, settings, playlists } from '../src/store.js';
import { GuildPlayer } from '../src/player/GuildPlayer.js';
import { PlayerManager } from '../src/player/manager.js';
import { commandJson, handleInteraction } from '../src/commands/index.js';
import { parseTime, resetRateLimits } from '../src/commands/util.js';
import { startHealthServer } from '../src/health.js';
import { FakeAudioPlayer, fakeResource, fakeSources, track, flush } from './helpers/fakes.js';

setLang('en');
before(() => setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-cmd-'))));

const DJ = { id: 'r-dj', name: 'DJ' };

function setup({ djRole = '', sourcesOpts = {}, limits = {} } = {}) {
  resetRateLimits();
  const sources = fakeSources(sourcesOpts);
  sources.resolve = async (q, opts) => {
    sources.calls.resolve.push({ q, opts });
    if (q === 'nothing') return { tracks: [] };
    return { tracks: [track(sources.calls.resolve.length, { title: `Res ${q.slice(0, 20)}` })] };
  };
  settings.set('g1', { volume: 60, autoplay: false }); // tests share the temp settings.json
  const guild = { id: 'g1', name: 'G', channels: { cache: new Map() } };
  const config = {
    djRole,
    defaultVolume: 60,
    limits: { idleLeaveMin: 0, aloneLeaveMin: 0, pauseLeaveMin: 0, pauseKillSec: 0, maxActivePlayers: 0, playRateCount: 0, maxPlaylist: 200, ...limits },
  };
  const manager = new PlayerManager({
    sources,
    config,
    settings,
    log: () => {},
    join: async () => ({ subscribe() {}, rejoin() {}, destroy() {}, state: { status: 'ready' } }),
    createPlayer: (o) => new GuildPlayer({ ...o, audioPlayer: new FakeAudioPlayer(), createResource: fakeResource }),
  });
  const sent = [];
  const textChannel = { id: 'tc1', send: async (m) => (sent.push(m), { edit: async () => {} }) };
  const ctx = { manager, sources, config, store: { settings, playlists }, log: () => {} };
  return { ctx, guild, textChannel, sent, sources, manager };
}

/** Minimal discord.js-like interaction. Records every reply-ish call as [method, payload, msSinceCreated]. */
function mock(env, { command, sub, options = {}, focused, user = 'u1', voice = 'vc1', roles = [], admin = false, customId, values, kind, guildId = 'g1' } = {}) {
  const t0 = Date.now();
  const calls = [];
  const rec = (name) => async (payload) => {
    calls.push([name, payload, Date.now() - t0]);
    if (name === 'deferReply' || name === 'deferUpdate') i.deferred = true;
    if (name === 'reply' || name === 'update') i.replied = true;
  };
  const channel = voice ? { id: voice, guild: env.guild, isVoiceBased: () => true } : null;
  const type = kind ?? (focused !== undefined ? 'autocomplete' : customId ? (values ? 'select' : 'button') : 'command');
  const i = {
    commandName: command,
    customId,
    values,
    guildId,
    guild: env.guild,
    channel: env.textChannel,
    user: { id: user },
    member: {
      voice: { channel },
      roles: { cache: new Collection(roles.map((r) => [r.id, r])) },
      permissions: { has: (f) => admin && (f === PermissionFlagsBits.Administrator || f === PermissionFlagsBits.ManageGuild) },
    },
    deferred: false,
    replied: false,
    calls,
    inGuild: () => true,
    isAutocomplete: () => type === 'autocomplete',
    isChatInputCommand: () => type === 'command',
    isButton: () => type === 'button',
    isStringSelectMenu: () => type === 'select',
    isRepliable: () => type !== 'autocomplete',
    options: {
      getString: (n, req) => {
        if (options[n] == null && req) throw new Error(`missing ${n}`);
        return options[n] ?? null;
      },
      getInteger: (n) => options[n] ?? null,
      getAttachment: (n) => options[n] ?? null,
      getSubcommand: () => sub,
      getFocused: () => focused,
    },
    reply: rec('reply'),
    deferReply: rec('deferReply'),
    editReply: rec('editReply'),
    followUp: rec('followUp'),
    respond: rec('respond'),
    update: rec('update'),
    deferUpdate: rec('deferUpdate'),
  };
  return i;
}

const run = async (env, o) => {
  const i = mock(env, o);
  await handleInteraction(i, env.ctx);
  await flush();
  return i;
};
const text = (call) => (typeof call[1] === 'string' ? call[1] : call[1]?.content ?? '');
const last = (i) => i.calls.at(-1);
const isEphemeral = (call) => Boolean(call[1]?.flags);

test('command JSON: 21 commands; /play has optional query (autocomplete) and file (attachment)', () => {
  const json = commandJson();
  assert.equal(json.length, 21);
  const play = json.find((c) => c.name === 'play');
  assert.deepEqual(
    play.options.map((o) => [o.name, o.type, Boolean(o.required), Boolean(o.autocomplete)]),
    [['query', 3, false, true], ['file', 11, false, false]],
  );
  assert.ok(play.description_localizations.pl);
});

test('/play: needs voice, defers, resolves, plays; second /play queues', async () => {
  const env = setup();
  const noVoice = await run(env, { command: 'play', options: { query: 'abc' }, voice: null });
  assert.equal(noVoice.calls.length, 1);
  assert.ok(isEphemeral(noVoice.calls[0]));
  assert.match(text(noVoice.calls[0]), /Join a voice channel/);

  const a = await run(env, { command: 'play', options: { query: 'first song' } });
  assert.equal(a.calls[0][0], 'deferReply');
  assert.equal(last(a)[0], 'editReply');
  assert.match(text(last(a)), /Playing: \*\*Artist 1 - Res first song/);
  const p = env.manager.get('g1');
  assert.equal(p.current.requestedBy, 'u1');
  assert.equal(p.textChannel, env.textChannel);

  const b = await run(env, { command: 'playnext', options: { query: 'second' } });
  assert.match(text(last(b)), /Up next/);
  const c = await run(env, { command: 'play', options: { query: 'nothing' } });
  assert.match(text(last(c)), /Nothing found/);
  const d = await run(env, { command: 'play', options: {} });
  assert.match(text(last(d)), /attach a file/);
  p.destroy();
});

test('/play file: validates type and size, passes the attachment to resolve()', async () => {
  const env = setup();
  const bad = await run(env, { command: 'play', options: { file: { url: 'https://cdn.discordapp.com/a/x.exe', name: 'x.exe', size: 10, contentType: 'application/x-msdownload' } } });
  assert.match(text(last(bad)), /can't play that file/);
  assert.ok(isEphemeral(last(bad)));
  const big = await run(env, { command: 'play', options: { file: { url: 'https://cdn.discordapp.com/a/b.flac', name: 'b.flac', size: 150 * 1024 * 1024, contentType: 'audio/flac' } } });
  assert.match(text(last(big)), /too big \(150\.0 MB\)/);
  const ok = await run(env, { command: 'play', options: { file: { url: 'https://cdn.discordapp.com/a/song.mp3', name: 'song.mp3', size: 5_000_000, contentType: 'audio/mpeg' } } });
  assert.match(text(last(ok)), /Playing/);
  const call = env.sources.calls.resolve.at(-1);
  assert.equal(call.q, 'https://cdn.discordapp.com/a/song.mp3');
  assert.deepEqual(call.opts.attachment, { url: 'https://cdn.discordapp.com/a/song.mp3', name: 'song.mp3', size: 5_000_000, contentType: 'audio/mpeg' });
  env.manager.destroyAll();
});

test('/play autocomplete answers within the deadline with partial results, then serves the cache; token values play directly', async () => {
  const env = setup();
  let releaseYt;
  env.sources.search = (q) => new Promise((r) => (releaseYt = () => r([track(50, { title: 'Slow Hit' })])));
  env.sources.localLibrary = () => ({
    search: async () => [track(60, { id: 'local:a/b.mp3', title: 'Local Tune', source: 'local', url: undefined })],
  });
  const ac = await run(env, { command: 'play', focused: 'tune' });
  const [method, choices, ms] = ac.calls[0];
  assert.equal(method, 'respond');
  assert.ok(ms < 2_900, `answered after ${ms} ms`);
  assert.equal(ac.calls.length, 1);
  assert.equal(choices.length, 1);
  assert.match(choices[0].name, /💾 Artist 60 - Local Tune/);
  assert.match(choices[0].value, /^ac:\d+$/);

  releaseYt();
  await flush();
  const again = await run(env, { command: 'play', focused: 'tune' });
  assert.ok(again.calls[0][2] < 100, 'cached answer is immediate');
  assert.deepEqual(again.calls[0][1].map((c) => c.value.startsWith('https://youtu.be/') || c.value.startsWith('ac:')), [true, true]);

  const before = env.sources.calls.resolve.length;
  const pl = await run(env, { command: 'play', options: { query: choices[0].value } });
  assert.match(text(last(pl)), /Local Tune/);
  assert.equal(env.sources.calls.resolve.length, before, 'token resolved from the autocomplete cache');
  const short = await run(env, { command: 'play', focused: 'a' });
  assert.deepEqual(short.calls[0][1], []);
  env.manager.destroyAll();
});

test('DJ_ROLE: stop/clear/volume need the role (or admin); skipping your own track does not', async () => {
  const env = setup({ djRole: 'DJ' });
  await run(env, { command: 'play', options: { query: 'mine' }, user: 'u1' });
  await run(env, { command: 'play', options: { query: 'other' }, user: 'u2' });
  const stop = await run(env, { command: 'stop', user: 'u1' });
  assert.match(text(last(stop)), /You need the \*\*DJ\*\* role/);
  assert.ok(isEphemeral(last(stop)));
  const vol = await run(env, { command: 'volume', options: { value: 120 }, user: 'u1' });
  assert.match(text(last(vol)), /DJ/);
  const skipOwn = await run(env, { command: 'skip', user: 'u1' });
  assert.match(text(last(skipOwn)), /Skipped: \*\*Artist 1 - Res mine/);
  const skipOther = await run(env, { command: 'skip', user: 'u1' });
  assert.match(text(last(skipOther)), /DJ/);
  const btn = await run(env, { customId: 'np:skip', user: 'u1' });
  assert.match(text(last(btn)), /DJ/);
  const djVol = await run(env, { command: 'volume', options: { value: 120 }, user: 'u3', roles: [DJ] });
  assert.match(text(last(djVol)), /Volume: \*\*120%/);
  assert.equal(settings.get('g1').volume, 120);
  const adminStop = await run(env, { command: 'stop', user: 'u4', admin: true });
  assert.match(text(last(adminStop)), /Stopped/);
  env.manager.destroyAll();
});

test('control commands require the bot\'s voice channel; seek parses mm:ss', async () => {
  const env = setup();
  await run(env, { command: 'play', options: { query: 'x' } });
  const away = await run(env, { command: 'pause', voice: 'vc2' });
  assert.match(text(last(away)), /my voice channel \(<#vc1>\)/);
  const bad = await run(env, { command: 'seek', options: { time: '9:99' } });
  assert.match(text(last(bad)), /mm:ss/);
  const ok = await run(env, { command: 'seek', options: { time: '1:30' } });
  assert.match(text(last(ok)), /Seeked to 1:30/);
  assert.deepEqual(env.sources.calls.createStream.at(-1), { id: 'yt:1', seekSec: 90, volume: 0.6 });
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('abc'), null);
  const loop = await run(env, { command: 'loop', options: { mode: 'queue' } });
  assert.match(text(last(loop)), /Loop: \*\*queue/);
  env.manager.destroyAll();
});

test('/queue paginates with buttons; now-playing buttons update the message', async () => {
  const env = setup();
  for (let n = 0; n < 13; n++) await run(env, { command: 'play', options: { query: `song ${n}` } });
  const q = await run(env, { command: 'queue' });
  const payload = last(q)[1];
  assert.match(payload.embeds[0].data.footer.text, /Page 1\/2 · 12 queued/);
  const nextBtn = payload.components[0].components[1].data;
  assert.equal(nextBtn.custom_id, 'q:1');
  const page2 = await run(env, { customId: 'q:1' });
  assert.equal(last(page2)[0], 'update');
  assert.match(last(page2)[1].embeds[0].data.description, /`11\.`/);

  const toggle = await run(env, { customId: 'np:toggle' });
  assert.equal(last(toggle)[0], 'update');
  assert.equal(env.manager.get('g1').pauseReason, 'user');
  assert.match(last(toggle)[1].embeds[0].data.author.name, /Paused/);
  const loop = await run(env, { customId: 'np:loop' });
  assert.equal(env.manager.get('g1').loop, 'track');
  assert.equal(last(loop)[0], 'update');
  assert.ok(env.sent.length >= 1, 'now-playing message posted to the text channel');
  env.manager.destroyAll();
});

test('/search shows a select menu; picking enqueues the track', async () => {
  const env = setup({ sourcesOpts: { searchResults: [track(7), track(8)] } });
  const s = await run(env, { command: 'search', options: { query: 'beat' } });
  assert.equal(s.calls[0][0], 'deferReply');
  assert.ok(s.calls[0][1].flags, 'ephemeral');
  const menu = last(s)[1].components[0].toJSON().components[0];
  assert.equal(menu.options.length, 2);
  const pick = await run(env, { customId: menu.custom_id, values: ['t:1'] });
  assert.equal(pick.calls[0][0], 'deferUpdate');
  assert.match(text(last(pick)), /Playing: \*\*Artist 8 - Song 8/);
  const stale = await run(env, { customId: 'pick:deadbeef00', values: ['t:0'] });
  assert.match(text(last(stale)), /expired/);
  env.manager.destroyAll();
});

test('/playlist save, list, load, delete (owner or DJ only)', async () => {
  const env = setup({ djRole: 'DJ' });
  const empty = await run(env, { command: 'playlist', sub: 'save', options: { name: 'Mix' } });
  assert.match(text(last(empty)), /Nothing to save/);
  await run(env, { command: 'play', options: { query: 'a' } });
  await run(env, { command: 'play', options: { query: 'b' } });
  const save = await run(env, { command: 'playlist', sub: 'save', options: { name: 'Mix' } });
  assert.match(text(last(save)), /Saved playlist \*\*Mix\*\* \(2 tracks\)/);
  assert.equal(playlists.get('g1', 'mix').tracks[0].requestedBy, undefined);
  const list = await run(env, { command: 'playlist', sub: 'list' });
  assert.match(last(list)[1].embeds[0].data.description, /Mix/);
  const ac = await run(env, { command: 'playlist', focused: 'mi' });
  assert.deepEqual(ac.calls[0][1], [{ name: 'Mix (2)', value: 'Mix' }]);
  const load = await run(env, { command: 'playlist', sub: 'load', options: { name: 'mix' } });
  assert.match(text(last(load)), /Loaded \*\*Mix\*\*: added 2/);
  assert.equal(env.manager.get('g1').queue.length, 3);
  const del = await run(env, { command: 'playlist', sub: 'delete', options: { name: 'Mix' }, user: 'u9' });
  assert.match(text(last(del)), /Only the author/);
  const del2 = await run(env, { command: 'playlist', sub: 'delete', options: { name: 'Mix' } });
  assert.match(text(last(del2)), /Deleted/);
  env.manager.destroyAll();
});

test('/autoplay without a player stores the setting; fallback note shows in replies', async () => {
  const env = setup();
  const a = await run(env, { command: 'autoplay', options: { state: 'on' } });
  assert.match(text(last(a)), /Autoplay on/);
  assert.equal(settings.get('g1').autoplay, true);
  env.sources.resolve = async () => ({ tracks: [track(5, { source: 'soundcloud', fallbackFrom: 'youtube' })] });
  const p = await run(env, { command: 'play', options: { query: 'blocked on yt' } });
  assert.match(text(last(p)), /Song 5 \(from SoundCloud\)/);
  settings.set('g1', { autoplay: false });
  env.manager.destroyAll();
});

test('health endpoint returns JSON status', async () => {
  const server = await startHealthServer(0, () => ({ guilds: 2, playing: 1 }));
  const { port } = server.address();
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.guilds, 2);
  assert.equal(typeof body.uptimeSec, 'number');
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  server.close();
});

test('limits: per-user /play rate limit, MAX_ACTIVE_PLAYERS, MAX_PLAYLIST trimming', async () => {
  const env = setup({ limits: { playRateCount: 2, playRateWindowSec: 10, maxActivePlayers: 1, maxPlaylist: 3 } });
  await run(env, { command: 'play', options: { query: 'one' } });
  await run(env, { command: 'play', options: { query: 'two' } });
  const third = await run(env, { command: 'play', options: { query: 'three' } });
  assert.match(text(last(third)), /at most 2 requests per 10 s/);
  assert.ok(isEphemeral(last(third)));
  const otherUser = await run(env, { command: 'play', options: { query: 'x' }, user: 'u2' });
  assert.match(text(last(otherUser)), /Added/);

  const busy = await run(env, { command: 'play', options: { query: 'elsewhere' }, user: 'u3', guildId: 'g2' });
  assert.match(text(last(busy)), /already playing in 1 places/);

  env.sources.resolve = async () => ({ tracks: [1, 2, 3, 4, 5].map((n) => track(100 + n)), playlist: { title: 'Big', count: 5 } });
  const pl = await run(env, { command: 'play', options: { query: 'big playlist' }, user: 'u4' });
  assert.match(text(last(pl)), /Added \*\*3\*\* tracks from \*\*Big\*\* \(2 skipped/);
  env.manager.destroyAll();
});

test('heartbeat file + `node src/healthcheck.js` exit codes', async () => {
  const { startHeartbeat, heartbeatAgeSec } = await import('../src/heartbeat.js');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-hb-'));
  const file = path.join(dir, 'heartbeat');
  // Private temp dir for the child too, so a real bot's fallback heartbeat can't make this pass.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-hbtmp-'));
  const check = () =>
    spawnSync(process.execPath, ['src/healthcheck.js'], { env: { ...process.env, DATA_DIR: dir, TMP: tmp, TEMP: tmp, TMPDIR: tmp }, encoding: 'utf8' });
  assert.equal(check().status, 1, 'missing heartbeat = unhealthy');
  let ready = false;
  const stopNotReady = startHeartbeat([file], () => ready);
  assert.equal(heartbeatAgeSec(file), Infinity, 'no beat while Discord is not ready');
  stopNotReady();
  ready = true;
  const stop = startHeartbeat([file], () => ready);
  assert.ok(heartbeatAgeSec(file) < 5);
  assert.equal(check().status, 0);
  stop();
  const old = new Date(Date.now() - 300_000);
  fs.utimesSync(file, old, old);
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /300 s old/);
});

// ---------------------------------------------------------------- review regressions

test('/play that finds nothing does not join voice (no MAX_ACTIVE_PLAYERS slot taken)', async () => {
  const env = setup({ limits: { maxActivePlayers: 1 } });
  const r = await run(env, { command: 'play', options: { query: 'nothing' } });
  assert.match(text(last(r)), /Nothing found/);
  assert.equal(env.manager.get('g1'), null);
  assert.equal(env.manager.players.size, 0);
});

test('fallback note shows "(from SoundCloud)" for a YouTube track played via SoundCloud', async () => {
  const { fallbackNote, trackLabel } = await import('../src/commands/util.js');
  const tr = track(1, { source: 'youtube', fallback: 'soundcloud', fallbackFrom: 'youtube' });
  assert.equal(fallbackNote(tr), '(from SoundCloud)');
  assert.equal(trackLabel(tr), 'Artist 1 - Song 1 (from SoundCloud)');
  assert.equal(fallbackNote(track(2)), '');
});

test('autocomplete does not cache empty (timed-out) search results', async () => {
  const env = setup();
  let calls = 0;
  env.sources.search = async () => (++calls === 1 ? [] : [track(70, { title: 'Found Later' })]);
  env.sources.localLibrary = () => ({ search: async () => [] });
  const a = await run(env, { command: 'play', focused: 'rare query' });
  assert.deepEqual(a.calls[0][1], []);
  const b = await run(env, { command: 'play', focused: 'rare query' });
  assert.equal(calls, 2, 'searched again');
  assert.match(b.calls[0][1][0].name, /Found Later/);
});

test('unwritable DATA_DIR: heartbeat falls back to a second location, store keeps working in memory', async () => {
  const { startHeartbeat, heartbeatAgeSec } = await import('../src/heartbeat.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-ro-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x'); // a file where a directory should be: mkdir/write fail like EACCES would
  const files = [path.join(blocker, 'data', 'heartbeat'), path.join(dir, 'fallback-heartbeat')];
  const logs = [];
  const stop = startHeartbeat(files, () => true, { log: (m) => logs.push(m) });
  stop();
  assert.equal(fs.existsSync(files[1]), true);
  assert.ok(heartbeatAgeSec(files) < 5);
  assert.match(logs[0], /cannot write/);

  const errors = [];
  const origErr = console.error;
  console.error = (m) => errors.push(m);
  try {
    setDataDir(path.join(blocker, 'data'));
    settings.set('gx', { volume: 33 });
    settings.set('gx', { volume: 34 });
    assert.equal(settings.get('gx').volume, 34, 'kept in memory');
    assert.equal(errors.length, 1, 'warned once');
  } finally {
    console.error = origErr;
    setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-cmd-')));
  }
});

test('DAVE failures recreate the connection without losing the player; a failed join posts one notice', async () => {
  const env = setup();
  const joins = [];
  const conns = [];
  env.manager.join = async (channel, opts) => {
    joins.push(opts);
    const c = { subscribe() {}, rejoin() {}, state: { status: 'ready' }, destroy() { this.state = { status: 'destroyed' }; opts.onGone(this); } };
    conns.push(c);
    return c;
  };
  env.guild.channels.cache.set('vc1', { id: 'vc1', guild: env.guild, members: { filter: () => ({ size: 1 }) } });
  await run(env, { command: 'play', options: { query: 'a' } });
  await run(env, { command: 'play', options: { query: 'b' } });
  const p = env.manager.get('g1');
  await joins[0].onDaveBroken(conns[0]);
  assert.equal(joins.length, 2);
  assert.equal(conns[0].state.status, 'destroyed');
  assert.equal(p.destroyed, false, 'player survives');
  assert.equal(p.connection, conns[1]);
  assert.equal(p.queue.length, 1, 'queue kept');
  conns[1].destroy(); // a real disconnect of the current connection still tears down
  assert.equal(p.destroyed, true);
  await flush();
  assert.equal(env.sent.filter((m) => /Disconnected/.test(m.content ?? '')).length, 1);

  const env2 = setup();
  env2.manager.join = async (channel, opts) => {
    opts.onGone({ state: { status: 'destroyed' } }); // voice.js destroys the half-open connection on failure
    throw new Error('timeout');
  };
  const r = await run(env2, { command: 'play', options: { query: 'x' } });
  assert.match(text(last(r)), /Couldn't connect/);
  await flush();
  assert.equal(env2.sent.length, 0, 'no extra "disconnected" notice');
});

test('now-playing: two quick trackStarts post one card', async () => {
  const { NowPlayingMessage } = await import('../src/ui/nowPlaying.js');
  const { EventEmitter } = await import('node:events');
  const p = Object.assign(new EventEmitter(), { current: track(1), queue: [], history: [], loop: 'off', volume: 60, autoplay: false, paused: false, position: () => 0 });
  let sends = 0;
  let edits = 0;
  p.textChannel = { send: async () => (sends++, await flush(), { edit: async () => edits++ }) };
  new NowPlayingMessage(p, { minGapMs: 0 });
  p.emit('trackStart', p.current);
  p.current = track(2);
  p.emit('trackStart', p.current);
  await flush(20);
  assert.equal(sends, 1);
  assert.ok(edits >= 1, 'the posted card is updated to the newer track');
  p.emit('destroyed');
});

test('resource summary line format', async () => {
  const { resourceLine } = await import('../src/health.js');
  assert.equal(resourceLine(1, 3, { rss: 150 * 1048576, heapUsed: 40 * 1048576 }, 7500), '[res] rss=150MB heap=40MB players=1/3 uptime=2h05m');
});
