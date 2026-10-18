// End-to-end: real ffmpeg decodes a generated mp3 into a real @discordjs/voice AudioPlayer
// (Raw resource + inlineVolume, Opus-encoded by the player). No Discord connection: noSubscriber = Play.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import { GuildPlayer } from '../src/player/GuildPlayer.js';
import { setLang } from '../src/ui/i18n.js';

setLang('en');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-e2e-'));
const mp3 = path.join(dir, 'tone.mp3');
const haveFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

before(() => {
  if (!haveFfmpeg) return;
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libmp3lame', '-b:a', '64k', mp3]);
  assert.equal(r.status, 0, String(r.stderr));
});

function ffmpegSources() {
  const procs = [];
  return {
    procs,
    async createStream(track, { seekSec = 0 } = {}) {
      const args = ['-hide_banner', '-loglevel', 'error'];
      if (seekSec) args.push('-ss', String(seekSec));
      args.push('-i', track.streamUrl, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      procs.push(proc);
      return {
        stream: proc.stdout,
        kill: () => {
          if (proc.exitCode === null && !proc.killed) proc.kill();
        },
      };
    },
  };
}

const tone = (n) => ({ id: `local:tone${n}.mp3`, title: `Tone ${n}`, durationSec: 2, source: 'local', isLive: false, streamUrl: mp3 });

function waitFor(cond, ms, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${what}`));
      }
    }, 20);
  });
}

test('Playing -> Idle advances the queue once per track; loop track replays', { skip: !haveFfmpeg && 'ffmpeg not found', timeout: 30_000 }, async () => {
  const sources = ffmpegSources();
  const audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const transitions = [];
  audio.on('stateChange', (o, n) => transitions.push(`${o.status}->${n.status}`));
  const p = new GuildPlayer({ guildId: 'e2e', sources, config: { defaultVolume: 50, idleLeaveMin: 0, aloneLeaveMin: 0 }, audioPlayer: audio });
  const started = [];
  let queueEnds = 0;
  const notices = [];
  p.on('trackStart', (tr) => started.push(tr.id));
  p.on('queueEnd', () => queueEnds++);
  p.on('notice', (m) => notices.push(m));

  p.enqueue([tone(1), tone(2)]);
  await waitFor(() => audio.state.status === 'playing', 5000, 'playing');
  assert.equal(p.resource.volume.volume, 0.5, 'inlineVolume applied');

  await waitFor(() => started.length === 2, 8000, 'second track');
  assert.deepEqual(p.history.map((x) => x.id), ['local:tone1.mp3']);

  p.setLoop('track');
  await waitFor(() => started.length === 3, 8000, 'loop replay');
  assert.deepEqual(started, ['local:tone1.mp3', 'local:tone2.mp3', 'local:tone2.mp3']);

  p.setLoop('off');
  await waitFor(() => queueEnds === 1, 8000, 'queue end');
  assert.equal(p.current, null);
  assert.deepEqual(notices, [], 'no track counted as failed');
  assert.ok(transitions.filter((x) => x === 'playing->idle').length === 3, transitions.join(' '));
  assert.equal(audio.state.status, 'idle');
  await waitFor(() => sources.procs.every((pr) => pr.exitCode !== null || pr.killed), 3000, 'ffmpeg exit');
  p.destroy();
});

test('skip and stop kill the running ffmpeg and do not double-advance', { skip: !haveFfmpeg && 'ffmpeg not found', timeout: 30_000 }, async () => {
  const sources = ffmpegSources();
  const audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const p = new GuildPlayer({ guildId: 'e2e2', sources, config: { defaultVolume: 60, idleLeaveMin: 0, aloneLeaveMin: 0 }, audioPlayer: audio });
  const started = [];
  p.on('trackStart', (tr) => started.push(tr.id));
  p.enqueue([tone(1), tone(2), tone(3)]);
  await waitFor(() => audio.state.status === 'playing', 5000, 'playing');
  p.skip();
  await waitFor(() => started.length === 2 && audio.state.status === 'playing', 5000, 'track 2');
  assert.deepEqual(started, ['local:tone1.mp3', 'local:tone2.mp3']);
  assert.deepEqual(p.queue.map((x) => x.id), ['local:tone3.mp3']);
  await waitFor(() => sources.procs[0].exitCode !== null || sources.procs[0].signalCode, 3000, 'first ffmpeg killed');
  p.seek(0.5);
  await waitFor(() => audio.state.status === 'playing' && sources.procs.length === 3, 5000, 'seek');
  assert.equal(p.current.id, 'local:tone2.mp3');
  p.stop();
  await waitFor(() => sources.procs.every((pr) => pr.exitCode !== null || pr.signalCode), 3000, 'all ffmpeg gone');
  assert.equal(p.current, null);
  assert.deepEqual(started, ['local:tone1.mp3', 'local:tone2.mp3']);
  p.destroy();
});
