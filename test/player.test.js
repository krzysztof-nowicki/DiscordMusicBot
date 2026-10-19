// GuildPlayer logic with a fake AudioPlayer and fake sources (no ffmpeg, no Discord).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuildPlayer } from '../src/player/GuildPlayer.js';
import { setLang } from '../src/ui/i18n.js';
import { setDataDir, settings } from '../src/store.js';
import { FakeAudioPlayer, fakeResource, fakeSources, track, flush } from './helpers/fakes.js';

setLang('en');
setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-player-')));

function make(opts = {}, srcOpts = {}) {
  const sources = fakeSources(srcOpts);
  const audio = new FakeAudioPlayer();
  const p = new GuildPlayer({
    guildId: opts.guildId ?? 'g1',
    sources,
    // 0 = disabled; individual tests turn limits on
    config: { defaultVolume: 60, limits: { idleLeaveMin: 0, aloneLeaveMin: 0, pauseLeaveMin: 0, pauseKillSec: 0, ...opts.limits } },
    settings: opts.settings ?? null,
    audioPlayer: audio,
    createResource: fakeResource,
  });
  const notices = [];
  p.on('notice', (m) => notices.push(m));
  return { p, audio, sources, notices };
}

const ids = (list) => list.map((x) => x.id);

test('enqueue starts the first track, queues the rest, natural end advances once', async () => {
  const { p, audio, sources } = make();
  const r1 = p.enqueue([track(1)], { requestedBy: 'u1' });
  assert.deepEqual(r1, { position: 0, startedNow: true, added: 1, dropped: 0 });
  const r2 = p.enqueue([track(2), track(3)], { requestedBy: 'u2' });
  assert.equal(r2.position, 1);
  await flush();
  assert.equal(p.current.id, 'yt:1');
  assert.equal(p.current.requestedBy, 'u1');
  assert.equal(audio.state.status, 'playing');
  assert.equal(audio.state.resource.volume.v, 0.6);

  audio.finish();
  await flush();
  assert.equal(p.current.id, 'yt:2');
  assert.deepEqual(ids(p.queue), ['yt:3']);
  assert.deepEqual(ids(p.history), ['yt:1']);
  assert.deepEqual(sources.calls.kill, ['yt:1']);
  assert.equal(sources.calls.createStream.length, 2);
});

test('loop track replays the same track and leaves the queue alone', async () => {
  const { p, audio, sources } = make();
  p.enqueue([track(1), track(2)]);
  await flush();
  p.setLoop('track');
  audio.finish();
  await flush();
  audio.finish();
  await flush();
  assert.equal(p.current.id, 'yt:1');
  assert.deepEqual(ids(p.queue), ['yt:2']);
  assert.deepEqual(sources.calls.createStream.map((c) => c.id), ['yt:1', 'yt:1', 'yt:1']);
});

test('skip with loop track moves on; the Idle from the stopped resource is not a second advance', async () => {
  const { p, sources } = make();
  p.enqueue([track(1), track(2), track(3)]);
  await flush();
  p.setLoop('track');
  p.skip();
  await flush();
  assert.equal(p.current.id, 'yt:2');
  assert.deepEqual(ids(p.queue), ['yt:3']);
  assert.deepEqual(sources.calls.kill, ['yt:1']);
});

test('skip n drops n-1 queued tracks; loop queue re-appends finished and skipped tracks', async () => {
  const { p, audio } = make();
  p.enqueue([1, 2, 3, 4, 5].map((n) => track(n)));
  await flush();
  p.skip(3);
  await flush();
  assert.equal(p.current.id, 'yt:4');
  assert.deepEqual(ids(p.queue), ['yt:5']);

  p.setLoop('queue');
  audio.finish();
  await flush();
  assert.equal(p.current.id, 'yt:5');
  assert.deepEqual(ids(p.queue), ['yt:4']);
  p.skip();
  await flush();
  assert.equal(p.current.id, 'yt:4');
  assert.deepEqual(ids(p.queue), ['yt:5']);
});

test('a skip during a slow createStream discards the late stream and kills it', async () => {
  const { p, sources } = make();
  let release;
  const orig = sources.createStream;
  sources.createStream = async (tr, o) => {
    if (tr.id === 'yt:1') await new Promise((r) => (release = r));
    return orig(tr, o);
  };
  p.enqueue([track(1), track(2)]);
  await flush();
  p.skip();
  await flush();
  assert.equal(p.current.id, 'yt:2');
  release();
  await flush();
  assert.equal(p.current.id, 'yt:2');
  assert.ok(sources.calls.kill.includes('yt:1'), 'late stream of the skipped track is killed');
  assert.equal(p.resource.track.id, 'yt:2');
});

test('seek recreates the stream with seekSec and position includes the offset', async () => {
  const { p, sources } = make();
  p.enqueue([track(1)]);
  await flush();
  assert.equal(p.seek(500), false, 'beyond the duration');
  assert.equal(p.seek(90), true);
  await flush();
  assert.deepEqual(sources.calls.createStream.at(-1), { id: 'yt:1', seekSec: 90, volume: 0.6 });
  assert.deepEqual(sources.calls.kill, ['yt:1']);
  p.resource.playbackDuration = 5000;
  assert.equal(p.position(), 95);
  assert.equal(p.seek(10), true);
  const live = make();
  live.p.enqueue([track(9, { isLive: true, durationSec: null })]);
  await flush();
  assert.equal(live.p.seek(10), false);
});

test('replay restarts the current track, or the last finished one when idle', async () => {
  const { p, audio, sources } = make();
  p.enqueue([track(1)]);
  await flush();
  p.replay();
  await flush();
  assert.equal(sources.calls.createStream.length, 2);
  audio.finish();
  await flush();
  assert.equal(p.current, null);
  assert.equal(p.replay().id, 'yt:1');
  await flush();
  assert.equal(p.current.id, 'yt:1');
});

test('shuffle keeps the same tracks; move and remove use 1-based positions', async () => {
  const { p } = make();
  p.enqueue([0, 1, 2, 3, 4, 5, 6, 7].map((n) => track(n)));
  await flush();
  p.shuffle();
  assert.deepEqual(ids(p.queue).sort(), ['yt:1', 'yt:2', 'yt:3', 'yt:4', 'yt:5', 'yt:6', 'yt:7']);
  p.queue.sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(p.move(1, 3).track.id, 'yt:1');
  assert.deepEqual(ids(p.queue).slice(0, 3), ['yt:2', 'yt:3', 'yt:1']);
  assert.equal(p.remove(2).id, 'yt:3');
  assert.equal(p.remove(99), null);
  assert.equal(p.move(0, 1), null);
  assert.equal(p.clear(), 6);
  assert.equal(p.queue.length, 0);
});

test('a failing track posts a notice and moves on; 3 failures in a row stop the player', async () => {
  const { p, notices, audio } = make({}, { failIds: ['yt:2', 'yt:3', 'yt:4'] });
  p.enqueue([track(1), track(2), track(5)]);
  await flush();
  audio.finish();
  await flush();
  assert.equal(p.current.id, 'yt:5', 'bad track skipped');
  assert.match(notices[0], /Song 2/);

  const b = make({}, { failIds: ['yt:2', 'yt:3', 'yt:4'] });
  b.p.enqueue([track(2), track(3), track(4), track(5)]);
  await flush(10);
  assert.equal(b.p.current, null);
  assert.equal(b.p.queue.length, 0, 'stopped and cleared');
  assert.ok(b.notices.some((m) => /Three tracks/.test(m)));
});

test('an AudioPlayer error or an empty stream counts as a failure; success resets the counter', async () => {
  const { p, audio, notices } = make();
  p.enqueue([track(1), track(2), track(3), track(4)]);
  await flush();
  audio.fail();
  await flush();
  assert.equal(p.current.id, 'yt:2');
  audio.finish(100); // 0.1 s of a 3 min track: the source gave nothing
  await flush();
  assert.equal(p.current.id, 'yt:3');
  assert.equal(p.failures, 2);
  audio.finish();
  await flush();
  assert.equal(p.failures, 0);
  assert.equal(notices.length, 2);
});

test('autoplay uses the YouTube mix, skipping tracks already played', async () => {
  const { p, audio, sources, notices } = make({}, { mix: [track(1), track(7)] });
  p.setAutoplay(true);
  p.enqueue([track(1)]);
  await flush();
  audio.finish();
  await flush(10);
  assert.match(sources.calls.resolve[0], /list=RD1/);
  assert.equal(p.current.id, 'yt:7');
  assert.equal(p.current.requestedBy, 'autoplay');
  assert.ok(notices.some((m) => /Autoplay/.test(m)));
});

test('autoplay falls back to search("related to <artist title>")', async () => {
  const { p, audio, sources } = make({}, { searchResults: [track(8, { id: 'sc:8', source: 'soundcloud' })] });
  p.setAutoplay(true);
  p.enqueue([track(1, { id: 'local:a.mp3', source: 'local' })]);
  await flush();
  let ended = false;
  p.on('queueEnd', () => (ended = true));
  audio.finish();
  await flush(10);
  assert.deepEqual(sources.calls.search, ['related to Artist 1 Song 1']);
  assert.equal(p.current.id, 'sc:8');
  assert.equal(ended, false);
});

test('queue end without autoplay emits queueEnd; stop clears and kills', async () => {
  const { p, audio, sources } = make();
  let ended = 0;
  p.on('queueEnd', () => ended++);
  p.enqueue([track(1), track(2)]);
  await flush();
  p.stop();
  assert.equal(p.current, null);
  assert.equal(p.queue.length, 0);
  assert.deepEqual(sources.calls.kill, ['yt:1']);
  assert.equal(audio.state.status, 'idle');
  await flush();
  assert.equal(ended, 0, 'stop is not a natural queue end');
  p.enqueue([track(3)]);
  await flush();
  audio.finish();
  await flush();
  assert.equal(ended, 1);
});

test('volume is applied to the resource and persisted per guild', async () => {
  const { p } = make({ guildId: 'gv', settings });
  p.enqueue([track(1)]);
  await flush();
  assert.equal(p.setVolume(250), 200);
  assert.equal(p.resource.volume.v, 2);
  p.setVolume(35);
  assert.equal(settings.get('gv').volume, 35);
  const again = make({ guildId: 'gv', settings });
  assert.equal(again.p.volume, 35);
});

test('pause/resume toggle', async () => {
  const { p, audio } = make();
  p.enqueue([track(1)]);
  await flush();
  assert.equal(p.togglePause(), true);
  assert.equal(audio.state.status, 'paused');
  assert.equal(p.paused, true);
  assert.equal(p.togglePause(), true);
  assert.equal(audio.state.status, 'playing');
});

test('next track is prefetched shortly before the current one ends', async () => {
  const { p, sources } = make();
  p.enqueue([track(1, { durationSec: 10 }), track(2)]);
  await flush();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sources.calls.prefetch, ['yt:2']);
  p.enqueue([track(3)]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sources.calls.prefetch, ['yt:2'], 'not prefetched twice; only the head');
});

test('ogg/opus: no inline volume; a volume change re-creates the stream at the position after a debounce', async () => {
  const { p, audio, sources } = make({}, { type: 'ogg/opus' });
  let starts = 0;
  p.on('trackStart', () => starts++);
  p.enqueue([track(1)]);
  await flush();
  assert.equal(p.resource.volume, undefined);
  assert.deepEqual(sources.calls.createStream[0], { id: 'yt:1', seekSec: 0, volume: 0.6 });
  p.resource.playbackDuration = 30_000;
  p.pause();
  p.setVolume(40);
  p.setVolume(30); // debounced: one re-create for both changes
  assert.equal(sources.calls.createStream.length, 1);
  await new Promise((r) => setTimeout(r, 750));
  await flush();
  assert.equal(sources.calls.createStream.length, 2);
  assert.deepEqual(sources.calls.createStream[1], { id: 'yt:1', seekSec: 30, volume: 0.3 });
  assert.deepEqual(sources.calls.kill, ['yt:1']);
  assert.equal(starts, 1, 'no new trackStart for a volume re-create');
  assert.equal(audio.state.status, 'paused', 'pause survives the re-create');
  assert.equal(p.position(), 30);
});

test('a volume change during the debounce is dropped when the user skips', async () => {
  const { p, sources } = make({}, { type: 'ogg/opus' });
  p.enqueue([track(1), track(2)]);
  await flush();
  p.setVolume(80);
  p.skip();
  await new Promise((r) => setTimeout(r, 750));
  await flush();
  assert.deepEqual(sources.calls.createStream.map((c) => [c.id, c.volume]), [['yt:1', 0.6], ['yt:2', 0.8]]);
});

test('fallbackFrom from the stream handle is kept on the track', async () => {
  const { p } = make({}, { fallbackIds: ['yt:1'] });
  p.enqueue([track(1, { source: 'soundcloud' })]);
  await flush();
  assert.equal(p.current.fallbackFrom, 'youtube');
});

// ---------------------------------------------------------------- resource limits (fake timers)

/** Records live timers created through the (mocked) globals so tests can assert nothing leaks. */
function trackTimers() {
  const live = new Set();
  const orig = { st: globalThis.setTimeout, ct: globalThis.clearTimeout, si: globalThis.setInterval, ci: globalThis.clearInterval };
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = orig.st(() => {
      live.delete(h);
      fn(...args);
    }, ms);
    live.add(h);
    return h;
  };
  globalThis.clearTimeout = (h) => {
    live.delete(h);
    orig.ct(h);
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    const h = orig.si(fn, ms, ...args);
    live.add(h);
    return h;
  };
  globalThis.clearInterval = (h) => {
    live.delete(h);
    orig.ci(h);
  };
  return {
    live,
    restore() {
      Object.assign(globalThis, { setTimeout: orig.st, clearTimeout: orig.ct, setInterval: orig.si, clearInterval: orig.ci });
    },
  };
}

test('idle: queue end leaves after IDLE_LEAVE_MIN', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, audio } = make({ limits: { idleLeaveMin: 5 } });
  let reason = null;
  p.on('destroyed', (r) => (reason = r));
  p.enqueue([track(1)]);
  await flush();
  audio.finish();
  await flush();
  t.mock.timers.tick(5 * 60_000 - 1);
  assert.equal(p.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(p.destroyed, true);
  assert.match(reason, /Nothing played for 5 min/);
});

test('alone: pauses at once, resumes when someone is back, leaves after ALONE_LEAVE_MIN', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, audio, sources } = make({ limits: { aloneLeaveMin: 3 } });
  let humans = 1;
  p.humanCount = () => humans;
  p.enqueue([track(1)]);
  await flush();
  humans = 0;
  p.checkAlone();
  assert.equal(audio.state.status, 'paused');
  assert.equal(p.pauseReason, 'alone');
  t.mock.timers.tick(2 * 60_000);
  humans = 1;
  p.checkAlone();
  assert.equal(audio.state.status, 'playing', 'auto-resumed');
  t.mock.timers.tick(5 * 60_000);
  assert.equal(p.destroyed, false, 'alone timer was cancelled');

  // A user pause is not undone by someone joining.
  p.pause();
  humans = 0;
  p.checkAlone();
  humans = 1;
  p.checkAlone();
  assert.equal(p.pauseReason, 'user');
  p.resume();

  humans = 0;
  p.checkAlone();
  t.mock.timers.tick(3 * 60_000);
  assert.equal(p.destroyed, true);
  assert.deepEqual(sources.calls.kill, ['yt:1']);
});

test('long pause: streams killed after PAUSE_KILL_SEC, resume re-creates at the position, leave after PAUSE_LEAVE_MIN', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, audio, sources } = make({ limits: { pauseKillSec: 60, pauseLeaveMin: 10 } });
  let starts = 0;
  p.on('trackStart', () => starts++);
  p.enqueue([track(1), track(2)]);
  await flush();
  p.resource.playbackDuration = 42_000;
  p.pause();
  t.mock.timers.tick(59_999);
  assert.deepEqual(sources.calls.kill, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sources.calls.kill, ['yt:1'], 'ffmpeg/yt-dlp killed while paused');
  assert.equal(p.resource, null);
  assert.equal(p.position(), 42);
  assert.equal(p.paused, true);
  assert.equal(p.current.id, 'yt:1');
  audio.emit('stateChange', { status: 'idle' }, { status: 'idle' }); // stray events don't advance
  assert.equal(p.current.id, 'yt:1');

  assert.equal(p.resume(), true);
  await flush();
  assert.deepEqual(sources.calls.createStream.at(-1), { id: 'yt:1', seekSec: 42, volume: 0.6 });
  assert.equal(audio.state.status, 'playing');
  assert.equal(starts, 1, 'resume is not a new track');

  p.pause();
  t.mock.timers.tick(10 * 60_000);
  assert.equal(p.destroyed, true);
});

test('MAX_QUEUE caps enqueue; prefetch stays one track ahead', async () => {
  const { p } = make({ limits: { maxQueue: 3 } });
  const r = p.enqueue([1, 2, 3, 4, 5, 6].map((n) => track(n)));
  assert.deepEqual([r.added, r.dropped], [4, 2], 'one playing + 3 queued');
  assert.equal(p.queue.length, 3);
  assert.deepEqual(p.enqueue([track(9)]), { position: -1, startedNow: false, added: 0, dropped: 1 });
});

test('no leaked timers after stop and destroy (player + now-playing message)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timers = trackTimers();
  t.after(() => timers.restore());
  const { NowPlayingMessage } = await import('../src/ui/nowPlaying.js');
  const { p, audio } = make({ limits: { idleLeaveMin: 5, aloneLeaveMin: 3, pauseLeaveMin: 10, pauseKillSec: 60 } });
  const edits = [];
  p.textChannel = { send: async () => ({ edit: async (m) => edits.push(m) }) };
  new NowPlayingMessage(p, { progressMs: 30_000, minGapMs: 0 });
  p.humanCount = () => 0;
  p.enqueue([track(1, { durationSec: 600 }), track(2)]);
  await flush();
  assert.ok(timers.live.size > 0, 'progress interval + prefetch timer running');
  p.checkAlone(); // alone: pause + alone timer + pause timers
  p.setVolume(10);
  t.mock.timers.tick(30_000);
  await flush();
  const editsWhilePaused = edits.length;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(edits.length, editsWhilePaused, 'no progress edits while paused/alone');

  p.stop();
  await flush();
  // Only the idle-leave timer (and the alone timer: still nobody there) may remain after stop.
  assert.equal(timers.live.size, 2);
  p.destroy();
  await flush();
  assert.equal(timers.live.size, 0, 'destroy clears every timer and interval');
  assert.equal(audio.state.status, 'idle');
});
