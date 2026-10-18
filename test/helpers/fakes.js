// Test doubles: fake AudioPlayer (same state/event shape as @discordjs/voice) and fake sources.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class FakeAudioPlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle' };
    this.played = [];
  }
  _set(s) {
    const old = this.state;
    this.state = s;
    this.emit('stateChange', old, s);
  }
  play(resource) {
    this.played.push(resource);
    this._set({ status: 'playing', resource });
  }
  stop() {
    if (this.state.status === 'idle') return false;
    this._set({ status: 'idle' });
    return true;
  }
  pause() {
    if (this.state.status !== 'playing') return false;
    this._set({ ...this.state, status: 'paused' });
    return true;
  }
  unpause() {
    if (this.state.status !== 'paused') return false;
    this._set({ ...this.state, status: 'playing' });
    return true;
  }
  /** Simulate the resource running out after `ms` of playback. */
  finish(ms = 120_000) {
    if (!this.state.resource) throw new Error('nothing playing');
    this.state.resource.playbackDuration = ms;
    this._set({ status: 'idle' });
  }
  /** Simulate a stream error (AudioPlayer emits error, then goes idle). */
  fail(msg = 'boom') {
    const resource = this.state.resource;
    const err = Object.assign(new Error(msg), { resource });
    this.emit('error', err);
    this._set({ status: 'idle' });
  }
}

export const fakeResource = (stream, track) => ({
  stream,
  track,
  playbackDuration: 0,
  volume: { v: 1, setVolume(v) { this.v = v; } },
});

export function track(n, extra = {}) {
  return { id: `yt:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, durationSec: 180, url: `https://youtu.be/${n}`, source: 'youtube', isLive: false, ...extra };
}

export function fakeSources({ failIds = [], searchResults = [], mix = null } = {}) {
  const calls = { createStream: [], kill: [], prefetch: [], search: [], resolve: [] };
  return {
    calls,
    async createStream(tr, opts = {}) {
      calls.createStream.push({ id: tr.id, seekSec: opts.seekSec ?? 0 });
      if (failIds.includes(tr.id)) {
        const e = new Error('Ten utwór jest niedostępny.');
        e.name = 'SourceError';
        e.userMessage = e.message;
        throw e;
      }
      const stream = new PassThrough();
      return { stream, kill: () => calls.kill.push(tr.id) };
    },
    async prefetch(tr) {
      calls.prefetch.push(tr.id);
    },
    async search(q, opts) {
      calls.search.push(q);
      return searchResults;
    },
    async resolve(q, opts) {
      calls.resolve.push(q);
      if (mix) return { tracks: mix };
      throw Object.assign(new Error('no mix'), { name: 'SourceError' });
    },
    localLibrary() {
      return { scan: async () => 0, search: async () => [], list: async (dir = '') => ({ dir, dirs: [], tracks: [] }) };
    },
  };
}

export const tick = () => new Promise((r) => setImmediate(r));
export async function flush(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}
