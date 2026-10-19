// One music player per guild: queue, history, loop modes, seek, volume, prefetch, autoplay, auto-leave and
// resource limits (small cloud instances: pause when alone, kill streams during long pauses, queue caps).
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
const MAX_FAILURES = 3;
const MIN_PLAYED_MS = 1000; // a track that ends sooner than this (from 0, not live, not tiny) counts as failed
const AUTOPLAY_RECENT = 25;
const VOLUME_RESTART_MS = 600; // ogg/opus streams bake the volume in: re-create after the slider settles

export const DEFAULT_LIMITS = {
  aloneLeaveMin: 3,
  idleLeaveMin: 5,
  pauseLeaveMin: 10,
  pauseKillSec: 60,
  prefetchLeadSec: 20,
  maxQueue: 500,
};

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
   * @param {{defaultVolume: number, limits?: Partial<typeof DEFAULT_LIMITS>}} o.config
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
    this.limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) };
    this.settings = settings;
    this.log = log;
    this.createResource = createResource;
    this.player =
      audioPlayer ?? createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 } });

    const saved = settings?.get(guildId) ?? {};
    this.volume = Number.isFinite(saved.volume) ? saved.volume : config.defaultVolume;
    this.autoplay = Boolean(saved.autoplay); // default off
    this.loop = 'off';

    /** @type {any[]} */ this.queue = [];
    /** @type {any[]} most recent first */ this.history = [];
    /** @type {any|null} */ this.current = null;
    this.resource = null;
    this.handle = null; // { stream, type, kill } of the current track
    this.abort = null; // AbortController of the current start (cancels a pending createStream on skip/stop)
    this.streamVolume = null; // volume baked into the current ogg/opus stream
    this.startOffset = 0; // seconds: where the current resource started (seek)
    /** @type {null|'user'|'alone'} why playback is paused (alone = auto-resume when someone comes back) */
    this.pauseReason = null;
    this.suspendedAt = null; // seconds: position kept after the paused stream was killed
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
    this.timers = { idle: null, alone: null, prefetch: null, volume: null, pauseKill: null, pauseLeave: null };

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

  /** Paused by the user, by being alone, or auto-paused by @discordjs/voice (no subscriber during a reconnect). */
  get paused() {
    return this.pauseReason !== null || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  get suspended() {
    return this.suspendedAt !== null;
  }

  /** Seconds into the current track. */
  position() {
    if (this.suspended) return this.suspendedAt;
    return this.startOffset + (this.resource ? this.resource.playbackDuration / 1000 : 0);
  }

  // ---------------------------------------------------------------- connection

  /** Attach a ready VoiceConnection (from voice.js) and remember the channel. */
  attach(connection, channelId) {
    this.connection = connection;
    this.channelId = channelId;
    connection.subscribe(this.player);
    if (!this.current) this._armIdle(); // connected but nothing queued yet: don't hold a player slot forever
  }

  // ---------------------------------------------------------------- queue operations

  /**
   * Adds at most `limits.maxQueue - queue.length` tracks.
   * @param {any[]} tracks
   * @param {{requestedBy?: string, next?: boolean}} [o]
   * @returns {{position: number, startedNow: boolean, added: number, dropped: number}}
   *   position of the first added track (0 = playing now)
   */
  enqueue(tracks, { requestedBy, next = false } = {}) {
    const room = Math.max(0, this.limits.maxQueue - this.queue.length + (this.current ? 0 : 1));
    const items = tracks.slice(0, room).map((tr) => ({ ...tr, requestedBy: requestedBy ?? tr.requestedBy }));
    const dropped = tracks.length - items.length;
    if (!items.length) return { position: -1, startedNow: false, added: 0, dropped };
    let position;
    if (next) {
      this.queue.unshift(...items);
      position = 1;
    } else {
      position = this.queue.length + 1;
      this.queue.push(...items);
    }
    const startedNow = !this.current;
    if (startedNow) {
      this.failures = 0;
      this._playNext();
      position = 0;
    } else {
      this._schedulePrefetch();
      this.emit('update');
    }
    return { position, startedNow, added: items.length, dropped };
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

  /** Stop playback and clear the queue (stays in the channel until the idle timer). */
  stop() {
    this.queue = [];
    const had = Boolean(this.current);
    if (this.current) this._pushHistory(this.current);
    this._halt();
    this._clearPause();
    this.current = null;
    this._armIdle();
    this.emit('stopped');
    return had;
  }

  /**
   * @param {'user'|'alone'} [reason]
   * Pausing arms two timers: kill the stream after pauseKillSec (resume re-creates it with a seek) and leave
   * after pauseLeaveMin.
   */
  pause(reason = 'user') {
    if (!this.current) return false;
    if (this.pauseReason) {
      if (reason === 'user' && this.pauseReason === 'alone') this.pauseReason = 'user'; // no auto-resume then
      return reason === 'user';
    }
    if (this.resource) this.player.pause(true);
    this.pauseReason = reason;
    const { pauseKillSec, pauseLeaveMin } = this.limits;
    if (pauseKillSec > 0) this.timers.pauseKill = this._timer(pauseKillSec * 1000, () => this._suspend());
    if (pauseLeaveMin > 0) {
      this.timers.pauseLeave = this._timer(pauseLeaveMin * 60_000, () => this.destroy(t('leftPaused', { min: pauseLeaveMin })));
    }
    this.emit('update');
    return true;
  }

  resume() {
    if (!this.pauseReason) return false;
    const at = this.suspendedAt;
    this._clearPause();
    if (at !== null) this._start(this.current, this.current.isLive ? 0 : at, { restart: true });
    else this.player.unpause();
    this.emit('update');
    return true;
  }

  togglePause() {
    return this.pauseReason ? this.resume() : this.pause('user');
  }

  /** Recreate the current stream starting at `sec` (also un-pauses). */
  seek(sec) {
    const cur = this.current;
    if (!cur || cur.isLive || sec < 0) return false;
    if (cur.durationSec != null && sec >= cur.durationSec) return false;
    this._start(cur, sec, { restart: true });
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
    this._clearTimer('prefetch');
    this.emit('update');
    return n;
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new Error(`bad loop mode ${mode}`);
    this.loop = mode;
    this.emit('update');
    return mode;
  }

  cycleLoop() {
    return this.setLoop(LOOP_MODES[(LOOP_MODES.indexOf(this.loop) + 1) % LOOP_MODES.length]);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(200, Math.round(v)));
    if (this.resource?.volume) this.resource.volume.setVolume(this.volume / 100);
    else if (this.resource) this._scheduleVolumeRestart(); // ogg/opus; a stream still opening is checked in _start
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

  // ---------------------------------------------------------------- auto-leave / pause handling

  /** Call when members of the bot's channel change: alone → pause now, leave later; someone back → resume. */
  checkAlone() {
    if (this.destroyed || !this.humanCount) return;
    if (this.humanCount() === 0) {
      if (this.current && !this.pauseReason) this.pause('alone');
      if (!this.timers.alone && this.limits.aloneLeaveMin > 0) {
        this.timers.alone = this._timer(this.limits.aloneLeaveMin * 60_000, () => this.destroy(t('leftAlone')));
      }
    } else {
      this._clearTimer('alone');
      if (this.pauseReason === 'alone') this.resume();
    }
  }

  /** Long pause: free CPU/RAM by killing ffmpeg/yt-dlp; the position is kept for resume(). */
  _suspend() {
    this.timers.pauseKill = null;
    if (!this.current || !this.pauseReason || this.suspended) return;
    const at = this.position();
    this._halt();
    this.suspendedAt = at;
    this.log(`[player] paused for long: stream closed at ${Math.round(at)} s`);
  }

  _clearPause() {
    this.pauseReason = null;
    this.suspendedAt = null;
    this._clearTimer('pauseKill');
    this._clearTimer('pauseLeave');
  }

  _armIdle() {
    if (this.timers.idle || this.destroyed || !(this.limits.idleLeaveMin > 0)) return;
    this.timers.idle = this._timer(this.limits.idleLeaveMin * 60_000, () =>
      this.destroy(t('leftIdle', { min: this.limits.idleLeaveMin })),
    );
  }

  /** Ogg/Opus has no inline volume: re-create the stream at the current position once changes settle. */
  _scheduleVolumeRestart() {
    this._clearTimer('volume');
    this.timers.volume = this._timer(VOLUME_RESTART_MS, () => {
      this.timers.volume = null;
      if (!this.current || this.destroyed || this.suspended || !this.resource) return;
      if (this.resource.volume || this.streamVolume === this.volume) return;
      this._start(this.current, this.current.isLive ? 0 : this.position(), { restart: true, keepPause: true });
    });
  }

  _timer(ms, fn) {
    const h = setTimeout(fn, ms);
    h?.unref?.();
    return h;
  }

  _clearTimer(name) {
    if (this.timers[name]) clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  // ---------------------------------------------------------------- playback internals

  /** Invalidate the current playback: resource first (so its Idle is ignored), then stop and kill processes. */
  _halt() {
    this.token++;
    this._clearTimer('prefetch');
    this._clearTimer('volume');
    this.abort?.abort();
    this.abort = null;
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

  /**
   * @param {{restart?: boolean, keepPause?: boolean}} [o]
   *   restart: same track re-created (seek/volume/resume) → no trackStart event.
   *   keepPause: stay paused afterwards (volume change while paused).
   */
  async _start(track, seekSec = 0, { restart = false, keepPause = false } = {}) {
    if (this.destroyed) return;
    const stayPaused = keepPause && this.pauseReason !== null;
    if (!stayPaused) this._clearPause();
    this._halt();
    const token = this.token;
    const ac = new AbortController();
    this.abort = ac;
    this.current = track;
    this.startOffset = seekSec;
    this.lastError = null;
    this._clearTimer('idle');

    const volume = this.volume; // what the stream is created with (ogg/opus bakes it in)
    let handle;
    try {
      handle = await this.sources.createStream(track, { seekSec, volume: volume / 100, signal: ac.signal });
    } catch (e) {
      if (token !== this.token || this.destroyed || ac.signal.aborted) return;
      this.log(`[player] createStream failed for ${track.id}: ${e.detail || e.message}`);
      this._failed(track, e);
      return;
    }
    if (token !== this.token || this.destroyed) {
      handle.kill(); // the user moved on while we were opening the stream
      return;
    }
    this.handle = handle;
    if (handle.fallback && !track.fallback) Object.assign(track, { fallback: handle.fallback, fallbackFrom: handle.fallbackFrom });
    else if (handle.fallbackFrom && !track.fallbackFrom) track.fallbackFrom = handle.fallbackFrom;
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
    this.streamVolume = resource.volume ? null : volume;
    this.resource = resource;
    this.player.play(resource);
    // Paused (by the user or by being alone) while the stream was opening: honour it now.
    if (this.pauseReason) this.player.pause(true);
    // Volume changed while an ogg/opus stream was opening: re-create it with the new volume.
    if (this.streamVolume !== null && this.streamVolume !== this.volume) this._scheduleVolumeRestart();
    if (!restart) this.emit('trackStart', track);
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
    this._clearPause();
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

  /** Prefetch only queue[0] (never more than one ahead), prefetchLeadSec before the current track ends. */
  _schedulePrefetch() {
    this._clearTimer('prefetch');
    if (!this.current || !this.sources.prefetch || this.destroyed) return;
    const next = this.queue[0];
    if (!next || this.prefetched.has(next)) return;
    const remain = this.current.durationSec != null ? this.current.durationSec - this.position() : null;
    if (remain == null) return; // live / unknown length: nothing to prepare for
    const delayMs = Math.max(0, (remain - this.limits.prefetchLeadSec) * 1000);
    this.timers.prefetch = this._timer(delayMs, () => {
      this.timers.prefetch = null;
      const head = this.queue[0];
      if (!head || this.prefetched.has(head) || this.paused) return;
      this.prefetched.add(head);
      Promise.resolve()
        .then(() => this.sources.prefetch(head))
        .catch((e) => this.log(`[player] prefetch failed: ${e.message}`));
    });
  }

  // ---------------------------------------------------------------- teardown

  /** Leave: kill streams, clear every timer, destroy the connection. `reason` (text) is posted by the manager. */
  destroy(reason = null) {
    if (this.destroyed) return;
    this.queue = [];
    this._halt();
    this._clearPause();
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
