// Shared helpers for command handlers: user-facing errors, permissions, time formatting, select-menu state.
import crypto from 'node:crypto';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { t } from '../ui/i18n.js';

/** An error whose message is shown to the user as-is (ephemeral). */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/** Administrator / Manage Server, or holds DJ_ROLE (by id or name). False when no DJ_ROLE and not admin. */
export function isPrivileged(member, config) {
  if (!member) return false;
  const perms = member.permissions;
  if (perms?.has?.(PermissionFlagsBits.Administrator) || perms?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (!config.djRole) return false;
  const want = config.djRole.toLowerCase();
  const roles = member.roles?.cache;
  if (roles) return roles.some((r) => r.id === config.djRole || r.name?.toLowerCase() === want);
  return Array.isArray(member.roles) && member.roles.includes(config.djRole);
}

/** Without DJ_ROLE everyone is a DJ. */
export function isDj(member, config) {
  return !config.djRole || isPrivileged(member, config);
}

export function requireDj(interaction, config) {
  if (!isDj(interaction.member, config)) throw new UserError(t('needDj', { role: config.djRole }));
}

export function memberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel ?? null;
}

export function requireVoice(interaction) {
  const ch = memberVoiceChannel(interaction);
  if (!ch) throw new UserError(t('notInVoice'));
  return ch;
}

/**
 * The guild's player; throws "nothing playing" if there is none (or nothing current when `current` is set).
 * Also enforces that the user is in the bot's channel (admins/DJ-role holders are exempt).
 */
export function controlPlayer(interaction, ctx, { current = true, sameChannel = true } = {}) {
  const player = ctx.manager.get(interaction.guildId);
  if (!player || player.destroyed || (current && !player.current)) throw new UserError(t('nothingPlaying'));
  if (sameChannel && player.channelId && memberVoiceChannel(interaction)?.id !== player.channelId && !isPrivileged(interaction.member, ctx.config)) {
    throw new UserError(t('notSameChannel', { channel: `<#${player.channelId}>` }));
  }
  return player;
}

/** "1:30", "01:02:03", "90" -> seconds; null if invalid. */
export function parseTime(s) {
  const parts = String(s ?? '').trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.slice(1).some((x) => x >= 60)) return null;
  return n.reduce((acc, x) => acc * 60 + x, 0);
}

export function fmtTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '?';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const SOURCE_EMOJI = {
  youtube: '📺',
  spotify: '🟢',
  soundcloud: '🟠',
  bandcamp: '🔵',
  local: '💾',
  attachment: '📎',
  http: '🔗',
  radio: '📻',
  generic: '🌐',
};

export const SOURCE_NAMES = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
  local: 'local',
  http: 'HTTP',
  radio: 'radio',
  generic: 'web',
  attachment: 'Discord',
};

/** "(z SoundCloud)" when the source fell back (e.g. YouTube blocked a datacenter IP → SoundCloud match). */
export function fallbackNote(tr) {
  if (!tr?.fallbackFrom || tr.fallbackFrom === tr.source) return '';
  return t('fromSource', { source: SOURCE_NAMES[tr.source] ?? tr.source });
}

export function trackLabel(tr) {
  const base = tr.artist && !tr.title.toLowerCase().includes(tr.artist.toLowerCase()) ? `${tr.artist} - ${tr.title}` : tr.title;
  const note = fallbackNote(tr);
  return note ? `${base} ${note}` : base;
}

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Escape markdown in titles we bold. */
export function md(s) {
  return String(s ?? '').replace(/([*_`~|\\])/g, '\\$1');
}

export function ephemeral(interaction, content) {
  const msg = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply({ content, allowedMentions: { parse: [] } });
  return interaction.reply(msg);
}

// ------------------------------------------------------------ select-menu state (search results, local browsing)

const PICK_TTL_MS = 15 * 60_000;
const picks = new Map();

export function storePick(data) {
  const now = Date.now();
  for (const [k, v] of picks) if (v.expires < now) picks.delete(k);
  const id = crypto.randomBytes(5).toString('hex');
  picks.set(id, { ...data, expires: now + PICK_TTL_MS });
  return id;
}

export function getPick(id) {
  const p = picks.get(id);
  if (!p || p.expires < Date.now()) return null;
  return p;
}

export function updatePick(id, patch) {
  const p = picks.get(id);
  if (p) Object.assign(p, patch, { expires: Date.now() + PICK_TTL_MS });
}

/** Reply text after enqueueing (result from enqueueTracks). */
export function addedText(result, tracks, playlist) {
  const n = result.added ?? tracks.length;
  let s;
  if (n > 1) {
    s = playlist?.title ? t('addedPlaylist', { count: n, title: md(playlist.title) }) : t('addedMany', { count: n });
  } else {
    const title = md(trackLabel(tracks[0]));
    s = result.startedNow ? t('playingNow', { title }) : t('added', { title, pos: result.position });
  }
  return result.dropped ? `${s} ${t('queueTrimmed', { count: result.dropped })}` : s;
}

/** Enqueue with the MAX_PLAYLIST cap (per request) and MAX_QUEUE cap (player); throws when nothing fits. */
export function enqueueTracks(player, tracks, { requestedBy, next = false, config }) {
  const max = config.limits?.maxPlaylist > 0 ? config.limits.maxPlaylist : Infinity;
  const capped = tracks.slice(0, max);
  const res = player.enqueue(capped, { requestedBy, next });
  if (!res.added) throw new UserError(t('queueFull', { max: player.limits.maxQueue }));
  res.dropped += tracks.length - capped.length;
  return res;
}

const rateLog = new Map();

/** Per-user rate limit for commands that add music (PLAY_RATE_COUNT per PLAY_RATE_WINDOW_SEC). */
export function checkRate(userId, config, now = Date.now()) {
  const count = config.limits?.playRateCount ?? 0;
  const sec = config.limits?.playRateWindowSec ?? 0;
  if (!(count > 0 && sec > 0)) return;
  const recent = (rateLog.get(userId) ?? []).filter((x) => now - x < sec * 1000);
  if (recent.length >= count) {
    rateLog.set(userId, recent);
    throw new UserError(t('rateLimited', { count, sec }));
  }
  recent.push(now);
  rateLog.set(userId, recent);
  if (rateLog.size > 1000) for (const [k, v] of rateLog) if (!v.some((x) => now - x < sec * 1000)) rateLog.delete(k);
}

/** For tests. */
export function resetRateLimits() {
  rateLog.clear();
}
