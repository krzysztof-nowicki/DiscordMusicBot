// One music player per guild: queue, history, loop modes, seek, volume, prefetch, autoplay and auto-leave.
//
// Transitions: every start/skip/stop/seek bumps `token` and clears `resource` BEFORE touching the AudioPlayer.
// The AudioPlayer's Idle event only advances the queue when the resource that went idle is still `this.resource`,
// so a manual stop/skip (which also fires Idle) never advances twice, and a slow createStream() that finishes
// after the user skipped is discarded.
import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { t } from '../ui/i18n.js';

const HISTORY_MAX = 50;
const PREFETCH_LEAD_SEC = 20; // warm up the next track this long before the current one ends
const MAX_FAILURES = 3;
const MIN_PLAYED_MS = 1000; // a track that ends sooner than this (from 0, not live, not tiny) counted as failed
const AUTOPLAY_RECENT = 25;
const VOLUME_RESTART_MS = 600; // ogg/opus streams bake the volume in: re-create after the slider settles

export const LOOP_MODES = ['off', 'track', 'queue'];

/** 'raw' = s16le 48k stereo (volume applied here); 'ogg/opus' = already encoded by ffmpeg (volume baked in). */
function defaultResource(stream, track, type = 'raw') {
  if (type === 'ogg/opus') return createAudioResource(stream, { inputType: StreamType.OggOpus });
  return createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
}

function errText(e) {
  if (e?.name === 'SourceError') return e.userMessage ?? e.message;
  return t('streamFailed');
}

/** Fisher-Yates, in place. */
export function shuffleArray(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Events: 'trackStart' (track), 'update' (pause/loop/volume/queue changed), 'queueEnd', 'stopped',
 * 'notice' (text for the text channel), 'destroyed' (reasonText|null).
 */
export class GuildPlayer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.guildId
   * @param {{createStream: Function, prefetch?: Function, search?: Function, resolve?: Function}} o.sources
   * @param {{defaultVolume: number, idleLeaveMin: number, aloneLeaveMin: number}} o.config
   * @param {{get: (g: string) => object, set: (g: string, patch: object) => void}} [o.settings]
   * @param {any} [o.audioPlayer]  @discordjs/voice AudioPlayer (or a fake in tests)
   * @param {(stream: any, track: any, type: 'raw'|'ogg/opus') => any} [o.createResource]
   * @param {(m: string) => void} [o.log]
   */
  constructor({ guildId, sources, config, settings = null, audioPlayer, createResource = defaultResource, log = () => {} }) {
    super();
    this.guildId = guildId;
    this.sources = sources;
    this.config = config;
    this.settings = settings;
    this.log = log;
    this.createResource = createResource;
    this.player =
      audioPlayer ?? createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 } });

    const saved = settings?.get(guildId) ?? {};
    this.volume = Number.isFinite(saved.volume) ? saved.volume : config.defaultVolume;
    this.autoplay = Boolean(saved.autoplay);
    this.loop = 'off';

    /** @type {any[]} */ this.queue = [];
    /** @type {any[]} most recent first */ this.history = [];
    /** @type {any|null} */ this.current = null;
    this.resource = null;
    this.handle = null; // { stream, type, kill } of the current track
    this.streamVolume = null; // volume baked into the current ogg/opus stream
    this.startOffset = 0; // seconds: where the current resource started (seek)
    this.token = 0;
    this.failures = 0;
    this.destroyed = false;
    this.connection = null;
    this.channelId = null;
    this.textChannel = null;
    /** () => number of humans in the bot's channel; set by the manager */
    this.humanCount = null;
    this.lastError = null;
    this.prefetched = new WeakSet();
    this.timers = { idle: null, alone: null, prefetch: null, volume: null };

    this.player.on('stateChange', (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Idle && oldS.status !== AudioPlayerStatus.Idle && oldS.resource) {
        if (oldS.resource === this.resource) this._onResourceEnd(oldS.resource);
      }
    });
    this.player.on('error', (e) => {
      this.lastError = e;
      this.log(`[player] ${e.message}`);
    });
  }

  // ---------------------------------------------------------------- state

  get paused() {
    const s = this.player.state.status;
    return s === AudioPlayerStatus.Paused || s === AudioPlayerStatus.AutoPaused;
  }

  get manuallyPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  /** Seconds into the current track. */
  position() {
    return this.startOffset + (this.resource ? this.resource.playbackDuration / 1000 : 0);
  }

  // ---------------------------------------------------------------- connection

  /** Attach a ready VoiceConnection (from voice.js) and remember the channel. */
  attach(connection, channelId) {
    this.connection = connection;
    this.channelId = channelId;
    connection.subscribe(this.player);
  }

  // ---------------------------------------------------------------- queue operations

  /**
   * @param {any[]} tracks
   * @param {{requestedBy?: string, next?: boolean}} [o]
   * @returns {{position: number, startedNow: boolean}} position of the first added track (0 = playing now)
   */
  enqueue(tracks, { requestedBy, next = false } = {}) {
    const items = tracks.map((tr) => ({ ...tr, requestedBy: requestedBy ?? tr.requestedBy }));
    let position;
    if (next) {
      this.queue.unshift(...items);
      position = 1;
    } else {
      position = this.queue.length + 1;
      this.queue.push(...items);
    }
    const startedNow = !this.current && items.length > 0;
    if (startedNow) {
      this.failures = 0;
      this._playNext();
      position = 0;
    } else {
      this._schedulePrefetch();
      this.emit('update');
    }
    return { position, startedNow };
  }

  /** Skip the current track and n-1 queued ones (loop "track" does not replay a skipped track). */
  skip(n = 1) {
    if (!this.current) return [];
    const skipped = [this.current, ...this.queue.splice(0, Math.max(0, n - 1))];
    this._halt();
    this.failures = 0;
    for (const tr of skipped) this._pushHistory(tr);
    if (this.loop === 'queue') this.queue.push(...skipped);
    this._playNext();
    return skipped;
  }

  /** Stop playback and clear the queue (stays in the channel). */
  stop() {
    this.queue = [];
    const had = Boolean(this.current);
    if (this.current) this._pushHistory(this.current);
    this._halt();
    this.current = null;
    this._armIdle();
    this.emit('stopped');
    return had;
  }

  pause() {
    if (!this.current || this.manuallyPaused) return false;
    const ok = this.player.pause(true);
    if (ok) {
      this._armIdle();
      this.emit('update');
    }
    return ok;
  }

  resume() {
    if (!this.manuallyPaused) return false;
    const ok = this.player.unpause();
    if (ok) {
      this._clearTimer('idle');
      this.emit('update');
    }
    return ok;
  }

  togglePause() {
    return this.manuallyPaused ? this.resume() : this.pause();
  }

  /** Recreate the current stream starting at `sec`. */
  seek(sec) {
    const cur = this.current;
    if (!cur || cur.isLive || sec < 0) return false;
    if (cur.durationSec != null && sec >= cur.durationSec) return false;
    this._start(cur, sec);
    return true;
  }

  /** Restart the current track, or the last finished one if nothing plays. */
  replay() {
    if (this.current) {
      this._start(this.current, 0);
      return this.current;
    }
    const last = this.history.shift();
    if (!last) return null;
    this.queue.unshift(last);
    this.failures = 0;
    this._playNext();
    return last;
  }

  /** 1-based queue positions. */
  remove(pos) {
    if (pos < 1 || pos > this.queue.length) return null;
    const [tr] = this.queue.splice(pos - 1, 1);
    this._schedulePrefetch();
    this.emit('update');
    return tr;
  }

  move(from, to) {
    if (from < 1 || from > this.queue.length || to < 1) return null;
    to = Math.min(to, this.queue.length);
    const [tr] = this.queue.splice(from - 1, 1);
    this.queue.splice(to - 1, 0, tr);
    this._schedulePrefetch();
    this.emit('update');
    return { track: tr, to };
  }

  shuffle() {
    shuffleArray(this.queue);
    this._schedulePrefetch();
    this.emit('update');
    return this.queue.length;
  }

  clear() {
    const n = this.queue.length;
    this.queue = [];
    this.emit('update');
    return n;
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new Error(`bad loop mode ${mode}`);
    this.loop = mode;
    this._schedulePrefetch();
    this.emit('update');
    return mode;
  }

  cycleLoop() {
    return this.setLoop(LOOP_MODES[(LOOP_MODES.indexOf(this.loop) + 1) % LOOP_MODES.length]);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(200, Math.round(v)));
    if (this.resource?.volume) this.resource.volume.setVolume(this.volume / 100);
    else if (this.current) this._scheduleVolumeRestart();
    this.settings?.set(this.guildId, { volume: this.volume });
    this.emit('update');
    return this.volume;
  }

  setAutoplay(on) {
    this.autoplay = Boolean(on);
    this.settings?.set(this.guildId, { autoplay: this.autoplay });
    this.emit('update');
    return this.autoplay;
  }

  // ---------------------------------------------------------------- auto-leave

  /** Call when members of the bot's channel change. */
  checkAlone() {
    if (this.destroyed || !this.humanCount) return;
    if (this.humanCount() === 0) {
      if (!this.timers.alone && this.config.aloneLeaveMin > 0) {
        this.timers.alone = this._timer(this.config.aloneLeaveMin * 60_000, () => this.destroy(t('leftAlone')));
      }
    } else {
      this._clearTimer('alone');
    }
  }

  _armIdle() {
    if (this.timers.idle || this.destroyed || !(this.config.idleLeaveMin > 0)) return;
    this.timers.idle = this._timer(this.config.idleLeaveMin * 60_000, () =>
      this.destroy(t('leftIdle', { min: this.config.idleLeaveMin })),
    );
  }

  /** Ogg/Opus has no inline volume: re-create the stream at the current position once changes settle. */
  _scheduleVolumeRestart() {
    this._clearTimer('volume');
    this.timers.volume = this._timer(VOLUME_RESTART_MS, () => {
      this.timers.volume = null;
      if (!this.current || this.destroyed) return;
      if (!this.resource) return this._scheduleVolumeRestart(); // still opening: try again shortly
      if (this.resource.volume || this.streamVolume === this.volume) return;
      this._start(this.current, this.current.isLive ? 0 : this.position(), { restart: true });
    });
  }

  _timer(ms, fn) {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  }

  _clearTimer(name) {
    clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  // ---------------------------------------------------------------- playback internals

  /** Invalidate the current playback: resource first (so its Idle is ignored), then stop and kill processes. */
  _halt() {
    this.token++;
    this._clearTimer('prefetch');
    this._clearTimer('volume');
    this.resource = null;
    const h = this.handle;
    this.handle = null;
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    if (h) {
      try {
        h.kill();
      } catch (e) {
        this.log(`[player] kill failed: ${e.message}`);
      }
    }
  }

  _pushHistory(track) {
    this.history.unshift(track);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
  }

  /** @param {{restart?: boolean}} [o] restart = same track re-created (volume change): no trackStart, keep pause */
  async _start(track, seekSec = 0, { restart = false } = {}) {
    if (this.destroyed) return;
    const wasPaused = restart && this.manuallyPaused;
    this._halt();
    const token = this.token;
    this.current = track;
    this.startOffset = seekSec;
    this.lastError = null;
    this._clearTimer('idle');

    let handle;
    try {
      handle = await this.sources.createStream(track, { seekSec, volume: this.volume / 100 });
    } catch (e) {
      if (token !== this.token || this.destroyed) return;
      this.log(`[player] createStream failed for ${track.id}: ${e.detail || e.message}`);
      this._failed(track, e);
      return;
    }
    if (token !== this.token || this.destroyed) {
      handle.kill(); // the user moved on while we were opening the stream
      return;
    }
    this.handle = handle;
    if (handle.fallbackFrom && !track.fallbackFrom) track.fallbackFrom = handle.fallbackFrom;
    handle.stream.on?.('error', (e) => this.log(`[player] stream error (${track.id}): ${e.message}`));
    let resource;
    try {
      resource = this.createResource(handle.stream, track, handle.type ?? 'raw');
    } catch (e) {
      this._halt();
      this._failed(track, e);
      return;
    }
    resource.volume?.setVolume(this.volume / 100);
    this.streamVolume = resource.volume ? null : this.volume;
    this.resource = resource;
    this.player.play(resource);
    if (wasPaused) this.player.pause(true);
    if (seekSec === 0 && !restart) this.emit('trackStart', track);
    else this.emit('update');
    this._schedulePrefetch();
  }

  _onResourceEnd(resource) {
    const track = this.current;
    const played = resource.playbackDuration;
    const err = this.lastError && this.lastError.resource === resource ? this.lastError : null;
    this.resource = null;
    const h = this.handle;
    this.handle = null;
    h?.kill();
    if (!track) return;
    const tiny = track.durationSec != null && track.durationSec <= 2;
    if (err || (played < MIN_PLAYED_MS && this.startOffset === 0 && !tiny)) {
      this._failed(track, err);
      return;
    }
    this.failures = 0;
    if (this.loop === 'track') {
      this._start(track, 0);
      return;
    }
    this._pushHistory(track);
    if (this.loop === 'queue') this.queue.push(track);
    this._playNext();
  }

  _failed(track, err) {
    this.failures++;
    this.emit('notice', t('trackFailed', { title: track.title, reason: errText(err) }));
    this.resource = null;
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.emit('notice', t('tooManyFailures'));
      this.stop();
      return;
    }
    this._pushHistory(track);
    this._playNext(); // a failing track is not re-queued by loop modes
  }

  _playNext() {
    const next = this.queue.shift();
    if (next) {
      this._start(next, 0);
      return;
    }
    this.current = null;
    this._onQueueEnd();
  }

  async _onQueueEnd() {
    const token = ++this.token;
    if (this.autoplay && this.history[0]) {
      const pick = await this._related(this.history[0]).catch((e) => {
        this.log(`[player] autoplay failed: ${e.message}`);
        return null;
      });
      if (pick && token === this.token && !this.current && !this.destroyed && this.queue.length === 0) {
        this.emit('notice', t('autoplayAdded', { title: pick.title }));
        this.queue.push({ ...pick, requestedBy: 'autoplay' });
        this._playNext();
        return;
      }
      if (token !== this.token || this.current) return; // someone queued meanwhile
    }
    if (this.destroyed) return;
    this._armIdle();
    this.emit('queueEnd');
  }

  /** Best-effort related track: YouTube mix for YouTube tracks, otherwise a search. */
  async _related(seed) {
    const recent = new Set(this.history.slice(0, AUTOPLAY_RECENT).flatMap((x) => [x.id, norm(x.title)]));
    const fresh = (list) => (list ?? []).find((x) => x && !recent.has(x.id) && !recent.has(norm(x.title)) && !x.isLive);
    const ytId = seed.id?.startsWith('yt:') ? seed.id.slice(3) : null;
    if (ytId && this.sources.resolve) {
      try {
        const mix = await this.sources.resolve(`https://www.youtube.com/watch?v=${ytId}&list=RD${ytId}`, { playlistLimit: 15 });
        const pick = fresh(mix?.tracks);
        if (pick) return pick;
      } catch (e) {
        this.log(`[player] autoplay mix failed: ${e.detail || e.message}`);
      }
    }
    if (!this.sources.search) return null;
    const q = `related to ${[seed.artist, seed.title].filter(Boolean).join(' ')}`;
    return fresh(await this.sources.search(q, { limit: 8 })) ?? null;
  }

  _schedulePrefetch() {
    this._clearTimer('prefetch');
    if (!this.current || !this.sources.prefetch || this.destroyed) return;
    const next = this.queue[0];
    if (!next || this.prefetched.has(next)) return;
    const remain = this.current.durationSec != null ? this.current.durationSec - this.position() : null;
    const delayMs = remain == null ? 5_000 : Math.max(0, (remain - PREFETCH_LEAD_SEC) * 1000);
    this.timers.prefetch = this._timer(delayMs, () => {
      this.timers.prefetch = null;
      const head = this.queue[0];
      if (!head || this.prefetched.has(head)) return;
      this.prefetched.add(head);
      Promise.resolve()
        .then(() => this.sources.prefetch(head))
        .catch((e) => this.log(`[player] prefetch failed: ${e.message}`));
    });
  }

  // ---------------------------------------------------------------- teardown

  /** Leave: kill streams, destroy the connection. `reason` (text) is posted by the manager. */
  destroy(reason = null) {
    if (this.destroyed) return;
    this.queue = [];
    this._halt();
    this.current = null;
    this.destroyed = true;
    for (const k of Object.keys(this.timers)) this._clearTimer(k);
    const c = this.connection;
    this.connection = null;
    if (c && c.state?.status !== 'destroyed') {
      try {
        c.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.emit('destroyed', reason);
  }
}

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
