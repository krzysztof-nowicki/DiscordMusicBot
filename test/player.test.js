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
    config: { defaultVolume: 60, idleLeaveMin: 0, aloneLeaveMin: 0, ...opts.config },
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
  assert.deepEqual(r1, { position: 0, startedNow: true });
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
  assert.deepEqual(sources.calls.createStream.at(-1), { id: 'yt:1', seekSec: 90 });
  assert.deepEqual(sources.calls.kill, ['yt:1']);
  p.resource.playbackDuration = 5000;
  assert.equal(p.position(), 95);
  assert.equal(p.seek(10) && true, true);
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

test('idle and alone timers make the player leave', async () => {
  const idle = make({ config: { idleLeaveMin: 0.001 } }); // 60 ms
  let reason = null;
  idle.p.on('destroyed', (r) => (reason = r));
  idle.p.enqueue([track(1)]);
  await flush();
  idle.audio.finish();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(idle.p.destroyed, true);
  assert.match(reason, /Nothing played/);

  const alone = make({ config: { aloneLeaveMin: 0.001 } });
  let humans = 1;
  alone.p.humanCount = () => humans;
  alone.p.enqueue([track(1)]);
  await flush();
  humans = 0;
  alone.p.checkAlone();
  humans = 1;
  alone.p.checkAlone(); // someone came back: timer cancelled
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(alone.p.destroyed, false);
  humans = 0;
  alone.p.checkAlone();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(alone.p.destroyed, true);
  assert.deepEqual(alone.sources.calls.kill, ['yt:1']);
});
