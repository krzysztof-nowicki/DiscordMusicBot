// Playback control: /pause /resume /skip /stop /leave /seek /replay /volume /loop /autoplay
import { SlashCommandBuilder } from 'discord.js';
import { describe, t } from '../ui/i18n.js';
import { UserError, controlPlayer, fmtTime, md, parseTime, requireDj, trackLabel } from './util.js';

const cmd = (name) => describe(new SlashCommandBuilder().setName(name), name);
const say = (interaction, content) => interaction.reply({ content, allowedMentions: { parse: [] } });

export const pause = {
  data: cmd('pause'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx);
    p.pause();
    await say(interaction, t('paused'));
  },
};

export const resume = {
  data: cmd('resume'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx);
    if (!p.resume()) throw new UserError(t('notPaused'));
    await say(interaction, t('resumed'));
  },
};

export const skip = {
  data: cmd('skip').addIntegerOption((o) => describe(o.setName('n'), 'opt_n').setMinValue(1).setMaxValue(1000)),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx);
    const n = interaction.options.getInteger('n') ?? 1;
    const affected = [p.current, ...p.queue.slice(0, n - 1)];
    // Anyone may skip their own tracks; skipping someone else's needs DJ_ROLE (when set).
    if (affected.some((tr) => tr.requestedBy !== interaction.user.id && tr.requestedBy !== 'autoplay')) requireDj(interaction, ctx.config);
    const skipped = p.skip(n);
    await say(interaction, skipped.length > 1 ? t('skippedN', { count: skipped.length }) : t('skipped', { title: md(trackLabel(skipped[0])) }));
  },
};

export const stop = {
  data: cmd('stop'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    requireDj(interaction, ctx.config);
    p.stop();
    await say(interaction, t('stopped'));
  },
};

export const leave = {
  data: cmd('leave'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    requireDj(interaction, ctx.config);
    p.destroy(null);
    await say(interaction, t('left'));
  },
};

export const seek = {
  data: cmd('seek').addStringOption((o) => describe(o.setName('time'), 'opt_time').setRequired(true)),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx);
    if (p.current.isLive) throw new UserError(t('seekLive'));
    const sec = parseTime(interaction.options.getString('time', true));
    if (sec == null || !p.seek(sec)) throw new UserError(t('seekInvalid'));
    await say(interaction, t('seeked', { time: fmtTime(sec) }));
  },
};

export const replay = {
  data: cmd('replay'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    const tr = p.replay();
    if (!tr) throw new UserError(t('nothingPlaying'));
    await say(interaction, t('replaying', { title: md(trackLabel(tr)) }));
  },
};

export const volume = {
  data: cmd('volume').addIntegerOption((o) => describe(o.setName('value'), 'opt_volume').setMinValue(0).setMaxValue(200)),
  async execute(interaction, ctx) {
    const value = interaction.options.getInteger('value');
    const p = controlPlayer(interaction, ctx, { current: false, sameChannel: value != null });
    if (value == null) return say(interaction, t('volumeSet', { v: p.volume }));
    requireDj(interaction, ctx.config);
    await say(interaction, t('volumeSet', { v: p.setVolume(value) }));
  },
};

export const loop = {
  data: cmd('loop').addStringOption((o) =>
    describe(o.setName('mode'), 'opt_mode')
      .setRequired(true)
      .addChoices(
        { name: 'off', value: 'off', name_localizations: { pl: 'wyłączone' } },
        { name: 'track', value: 'track', name_localizations: { pl: 'utwór' } },
        { name: 'queue', value: 'queue', name_localizations: { pl: 'kolejka' } },
      ),
  ),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    const mode = p.setLoop(interaction.options.getString('mode', true));
    await say(interaction, t('loopSet', { mode: t(`loop_${mode}`) }));
  },
};

export const autoplay = {
  data: cmd('autoplay').addStringOption((o) =>
    describe(o.setName('state'), 'opt_state')
      .setRequired(true)
      .addChoices({ name: 'on', value: 'on', name_localizations: { pl: 'włącz' } }, { name: 'off', value: 'off', name_localizations: { pl: 'wyłącz' } }),
  ),
  async execute(interaction, ctx) {
    const want = interaction.options.getString('state', true) === 'on';
    const existing = ctx.manager.get(interaction.guildId);
    let on = want;
    if (existing && !existing.destroyed) on = controlPlayer(interaction, ctx, { current: false }).setAutoplay(want);
    else ctx.store.settings.set(interaction.guildId, { autoplay: want }); // applies when the bot next joins
    await say(interaction, on ? t('autoplayOn') : t('autoplayOff'));
  },
};

