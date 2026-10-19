// Now-playing embed + control buttons (edited in place), queue embed with pagination, and their button handlers.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { t } from './i18n.js';
import { SOURCE_EMOJI, UserError, clip, controlPlayer, fallbackNote, fmtTime, isDj, md, trackLabel } from '../commands/util.js';

const PROGRESS_EDIT_MS = 30_000; // progress bar refresh (NP_UPDATE_SEC); only while playing
const MIN_EDIT_GAP_MS = 2_000; // coalesce bursts of state changes
const QUEUE_PAGE = 10;
const COLOR = 0x5865f2;

export function progressBar(pos, dur, width = 14) {
  if (!dur) return '';
  const k = Math.min(width - 1, Math.max(0, Math.round((pos / dur) * (width - 1))));
  return `${'▬'.repeat(k)}🔘${'▬'.repeat(width - 1 - k)}`;
}

const requester = (tr) => (!tr.requestedBy ? '-' : tr.requestedBy === 'autoplay' ? t('npAutoplay') : `<@${tr.requestedBy}>`);
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const loopEmoji = (mode) => (mode === 'track' ? '🔂' : '🔁');

/** @param {import('../player/GuildPlayer.js').GuildPlayer} player */
export function nowPlayingEmbed(player, { finished = false } = {}) {
  const tr = player.current;
  const e = new EmbedBuilder().setColor(COLOR);
  if (finished || !tr) {
    return e.setAuthor({ name: `⏹ ${t('npFinished')}` }).setDescription(player.history[0] ? md(trackLabel(player.history[0])) : null);
  }
  const head = player.paused ? `⏸ ${t('npPaused')}` : `${SOURCE_EMOJI[tr.source] ?? '🎵'} ${t('npTitle')}`;
  const note = fallbackNote(tr);
  e.setAuthor({ name: note ? `${head} ${note}` : head }).setTitle(clip(tr.title, 256));
  if (isHttp(tr.url)) e.setURL(tr.url);
  if (isHttp(tr.thumbnail)) e.setThumbnail(tr.thumbnail);
  const pos = player.position();
  e.setDescription(
    tr.isLive || tr.durationSec == null
      ? `${t('npLive')} · ${fmtTime(pos)}`
      : `${progressBar(pos, tr.durationSec)}\n\`${fmtTime(pos)} / ${fmtTime(tr.durationSec)}\``,
  );
  const fields = [];
  if (tr.artist) fields.push({ name: t('npArtist'), value: clip(md(tr.artist), 1024), inline: true });
  fields.push({ name: t('npRequested'), value: requester(tr), inline: true });
  fields.push({
    name: t('npLoop'),
    value: `${loopEmoji(player.loop)} ${t(`loop_${player.loop}`)}${player.autoplay ? ' · ♾️' : ''}`,
    inline: true,
  });
  fields.push({ name: t('npVolume'), value: `${player.volume}%`, inline: true });
  const next = player.queue[0];
  fields.push({
    name: t('npQueue'),
    value: next ? `${player.queue.length} · ${clip(t('npNext', { title: md(trackLabel(next)) }), 200)}` : '0',
    inline: true,
  });
  e.addFields(fields);
  e.setFooter({ text: tr.source });
  return e;
}

export function controlRow(player, disabled = false) {
  const b = (id, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`np:${id}`).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  return new ActionRowBuilder().addComponents(
    b('toggle', '⏯️', player.paused ? ButtonStyle.Success : ButtonStyle.Secondary),
    b('skip', '⏭️'),
    b('stop', '⏹️', ButtonStyle.Danger),
    b('loop', loopEmoji(player.loop), player.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    b('shuffle', '🔀'),
  );
}

export function nowPlayingPayload(player, opts = {}) {
  const finished = opts.finished || !player.current;
  return {
    embeds: [nowPlayingEmbed(player, { finished })],
    components: finished ? [] : [controlRow(player)],
    allowedMentions: { parse: [] },
  };
}

/** Queue page (0-based) with ◀ ▶ buttons. */
export function queuePayload(player, page = 0) {
  const q = player?.queue ?? [];
  const pages = Math.max(1, Math.ceil(q.length / QUEUE_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const e = new EmbedBuilder().setColor(COLOR).setTitle(t('queueTitle'));
  const cur = player?.current;
  const lines = [];
  if (cur) {
    const link = isHttp(cur.url) ? `[${clip(md(trackLabel(cur)), 80)}](${cur.url})` : clip(md(trackLabel(cur)), 80);
    lines.push(`**${t('queueNow')}:** ${link} · \`${cur.isLive ? 'LIVE' : fmtTime(cur.durationSec)}\``, '');
  }
  if (!q.length) lines.push(t('queueEmpty'));
  else {
    lines.push(`**${t('queueUpNext')}:**`);
    q.slice(page * QUEUE_PAGE, (page + 1) * QUEUE_PAGE).forEach((tr, i) => {
      const n = page * QUEUE_PAGE + i + 1;
      lines.push(`\`${n}.\` ${clip(md(trackLabel(tr)), 70)} · \`${tr.isLive ? 'LIVE' : fmtTime(tr.durationSec)}\` · ${requester(tr)}`);
    });
  }
  e.setDescription(lines.join('\n').slice(0, 4096));
  const total = q.reduce((s, tr) => s + (tr.durationSec ?? 0), 0);
  e.setFooter({ text: t('queueFooter', { page: page + 1, pages, count: q.length, duration: fmtTime(total) }) });
  const components = [];
  if (pages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`q:${page - 1}`).setLabel(t('btnPrev')).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`q:${page + 1}`).setLabel(t('btnNext')).setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
      ),
    );
  }
  return { embeds: [e], components, allowedMentions: { parse: [] } };
}

/**
 * Keeps one now-playing message per player in its text channel, edited in place: immediately (coalesced) on
 * track/state changes, and every ~15 s for the progress bar while playing. After stop/queue end the message is
 * finalised and the next track posts a fresh one.
 */
export class NowPlayingMessage {
  constructor(player, { log = () => {}, progressMs = PROGRESS_EDIT_MS, minGapMs = MIN_EDIT_GAP_MS } = {}) {
    this.player = player;
    this.log = log;
    this.progressMs = progressMs;
    this.minGapMs = minGapMs;
    this.message = null;
    this.live = false; // message shows an active track
    this.busy = false;
    this.dirty = false;
    this.lastEdit = 0;
    this.gapTimer = null;
    this.interval = null;
    this.sending = null; // promise of the card being posted
    player.on('trackStart', () => this.show());
    player.on('update', () => this.refresh());
    player.on('queueEnd', () => this.finish());
    player.on('stopped', () => this.finish());
    player.on('destroyed', () => this.finish());
  }

  async show() {
    clearInterval(this.interval);
    this.interval = setInterval(() => {
      if (this.player.current && !this.player.paused) this.refresh();
    }, this.progressMs);
    this.interval.unref?.();
    if (this.sending) {
      // A card is being posted right now (two trackStarts in a row): edit that one instead of posting another.
      this.dirty = true;
      return this.sending;
    }
    if (this.message && this.live) return this.refresh(true);
    const ch = this.player.textChannel;
    if (!ch?.send) return;
    this.live = true;
    this.sending = this._send(ch);
    await this.sending;
    this.sending = null;
    if (this.dirty && this.live && this.message) this.refresh(true);
  }

  async _send(ch) {
    try {
      this.busy = true;
      this.message = await ch.send(nowPlayingPayload(this.player));
      this.lastEdit = Date.now();
    } catch (e) {
      this.log(`[np] cannot send: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Edit the message, at most once per minGapMs; bursts are coalesced into one trailing edit. */
  refresh(force = false) {
    if (!this.message || !this.live) return;
    if (this.busy || this.gapTimer) {
      this.dirty = true;
      return;
    }
    const wait = force ? 0 : this.lastEdit + this.minGapMs - Date.now();
    if (wait > 0) {
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        this.refresh(true);
      }, wait);
      this.gapTimer.unref?.();
      return;
    }
    this._edit(nowPlayingPayload(this.player));
  }

  async _edit(payload) {
    const msg = this.message;
    if (!msg) return;
    this.busy = true;
    this.dirty = false;
    try {
      await msg.edit(payload);
    } catch (e) {
      this.log(`[np] edit failed: ${e.message}`);
      if (this.message === msg) this.message = null; // deleted: the next track posts a new one
    } finally {
      this.busy = false;
      this.lastEdit = Date.now();
    }
    if (this.dirty && this.live) this.refresh();
  }

  async finish() {
    clearInterval(this.interval);
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
    if (!this.live) return;
    this.live = false;
    const msg = this.message;
    this.message = null;
    if (msg) await msg.edit(nowPlayingPayload(this.player, { finished: true })).catch(() => {});
  }
}

// ------------------------------------------------------------ button handlers

/** Buttons under the now-playing message: np:toggle|skip|stop|loop|shuffle */
export async function handleNowPlayingButton(interaction, ctx) {
  const action = interaction.customId.split(':')[1];
  const player = controlPlayer(interaction, ctx);
  const dj = isDj(interaction.member, ctx.config);
  if (action === 'skip' && !dj && player.current.requestedBy !== interaction.user.id) {
    throw new UserError(t('needDj', { role: ctx.config.djRole }));
  }
  if (action === 'stop' && !dj) throw new UserError(t('needDj', { role: ctx.config.djRole }));
  if (action === 'toggle') player.togglePause();
  else if (action === 'skip') player.skip();
  else if (action === 'stop') player.stop();
  else if (action === 'loop') player.cycleLoop();
  else if (action === 'shuffle') player.shuffle();
  // Re-render this message right away (the controller's own edit is coalesced with it).
  await interaction.update(nowPlayingPayload(player));
}

/** Queue pagination: q:<page> */
export async function handleQueueButton(interaction, ctx) {
  const page = Number(interaction.customId.split(':')[1]) || 0;
  await interaction.update(queuePayload(ctx.manager.get(interaction.guildId), page));
}

