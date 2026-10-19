// Owns one GuildPlayer per guild: joins voice, wires notices and the now-playing message, handles voice-state updates.
import { GuildPlayer } from './GuildPlayer.js';
import { joinChannel } from './voice.js';
import { NowPlayingMessage } from '../ui/nowPlaying.js';
import { UserError } from '../commands/util.js';
import { t } from '../ui/i18n.js';

export class PlayerManager {
  /**
   * @param {object} o
   * @param {any} o.sources
   * @param {any} o.config
   * @param {any} [o.settings]
   * @param {(m: string) => void} [o.log]
   * @param {typeof joinChannel} [o.join]
   * @param {(opts: object) => GuildPlayer} [o.createPlayer]
   */
  constructor({ sources, config, settings = null, log = console.log, join = joinChannel, createPlayer }) {
    this.sources = sources;
    this.config = config;
    this.settings = settings;
    this.log = log;
    this.join = join;
    this.createPlayer = createPlayer ?? ((opts) => new GuildPlayer(opts));
    /** @type {Map<string, GuildPlayer>} */
    this.players = new Map();
    /** @type {Map<string, Promise<GuildPlayer>>} joins in progress */
    this.pending = new Map();
  }

  get(guildId) {
    const p = this.players.get(guildId);
    return p && !p.destroyed ? p : null;
  }

  /** Player for the member's voice channel, joining (or moving) as needed. Throws UserError for the user. */
  async connect(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) throw new UserError(t('notInVoice'));
    const guildId = interaction.guildId;
    if (this.pending.has(guildId)) await this.pending.get(guildId).catch(() => {});
    let p = this.get(guildId);
    if (p) {
      if (interaction.channel) p.textChannel = interaction.channel;
      if (p.channelId === channel.id) return p;
      // In another channel: only move when nobody is listening there or nothing is playing.
      if (p.current && (p.humanCount?.() ?? 0) > 0) {
        throw new UserError(t('alreadyElsewhere', { channel: `<#${p.channelId}>` }));
      }
      p.connection?.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
      p.channelId = channel.id;
      p.checkAlone();
      return p;
    }
    const max = this.config.limits?.maxActivePlayers ?? 0;
    if (max > 0 && this.players.size + this.pending.size >= max) throw new UserError(t('tooBusy', { max }));
    const job = this._create(channel, interaction.channel);
    this.pending.set(guildId, job);
    try {
      return await job;
    } finally {
      this.pending.delete(guildId);
    }
  }

  async _create(channel, textChannel) {
    const guild = channel.guild;
    const log = (m) => this.log(`[${guild.name ?? guild.id}] ${m}`);
    const p = this.createPlayer({ guildId: guild.id, sources: this.sources, config: this.config, settings: this.settings, log });
    p.textChannel = textChannel;
    p.humanCount = () => {
      const ch = guild.channels?.cache?.get(p.channelId);
      return ch ? ch.members.filter((m) => !m.user.bot).size : 0;
    };
    new NowPlayingMessage(p, { log, progressMs: (this.config.limits?.npUpdateSec ?? 30) * 1000 });
    p.on('notice', (text) => this._post(p, text));
    p.on('destroyed', (reason) => {
      if (reason) this._post(p, reason);
      if (this.players.get(guild.id) === p) this.players.delete(guild.id);
      log('player closed');
    });
    let connection;
    try {
      connection = await this.join(channel, { log, onGone: () => p.destroy(t('disconnected')) });
    } catch (e) {
      log(`voice join failed: ${e.message}`);
      p.destroy(null);
      throw new UserError(t('joinFailed'));
    }
    p.attach(connection, channel.id);
    this.players.set(guild.id, p);
    p.checkAlone();
    return p;
  }

  _post(p, content) {
    p.textChannel?.send?.({ content, allowedMentions: { parse: [] } }).catch((e) => this.log(`[post] ${e.message}`));
  }

  /** Wire to Events.VoiceStateUpdate. */
  onVoiceStateUpdate(oldState, newState, botId) {
    const p = this.get(newState.guild.id);
    if (!p) return;
    if (newState.id === botId) {
      // Dragged to another channel by someone: follow it. Disconnects are handled by the connection itself.
      if (newState.channelId && newState.channelId !== p.channelId) p.channelId = newState.channelId;
    } else if (oldState.channelId !== p.channelId && newState.channelId !== p.channelId) {
      return;
    }
    p.checkAlone();
  }

  destroyAll() {
    for (const p of [...this.players.values()]) p.destroy(null);
  }
}
