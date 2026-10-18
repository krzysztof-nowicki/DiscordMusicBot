// Queue inspection and editing: /queue /nowplaying /remove /move /shuffle /clear
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { describe, t } from '../ui/i18n.js';
import { nowPlayingPayload, queuePayload } from '../ui/nowPlaying.js';
import { UserError, controlPlayer, md, requireDj, trackLabel } from './util.js';

const cmd = (name) => describe(new SlashCommandBuilder().setName(name), name);
const say = (interaction, content) => interaction.reply({ content, allowedMentions: { parse: [] } });
const posOpt = (name, key) => (o) => describe(o.setName(name), key).setRequired(true).setMinValue(1);

export const queue = {
  data: cmd('queue').addIntegerOption((o) => describe(o.setName('page'), 'opt_page').setMinValue(1)),
  async execute(interaction, ctx) {
    const p = ctx.manager.get(interaction.guildId);
    if (!p || p.destroyed || (!p.current && !p.queue.length)) {
      return interaction.reply({ content: t('queueEmpty'), flags: MessageFlags.Ephemeral });
    }
    await interaction.reply(queuePayload(p, (interaction.options.getInteger('page') ?? 1) - 1));
  },
};

export const nowplaying = {
  data: cmd('nowplaying'),
  async execute(interaction, ctx) {
    const p = ctx.manager.get(interaction.guildId);
    if (!p?.current) return interaction.reply({ content: t('nothingPlaying'), flags: MessageFlags.Ephemeral });
    await interaction.reply(nowPlayingPayload(p));
  },
};

export const remove = {
  data: cmd('remove').addIntegerOption(posOpt('position', 'opt_pos')),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    const pos = interaction.options.getInteger('position', true);
    const target = p.queue[pos - 1];
    if (!target) throw new UserError(t('badPosition'));
    if (target.requestedBy !== interaction.user.id) requireDj(interaction, ctx.config);
    p.remove(pos);
    await say(interaction, t('removed', { title: md(trackLabel(target)) }));
  },
};

export const move = {
  data: cmd('move').addIntegerOption(posOpt('from', 'opt_from')).addIntegerOption(posOpt('to', 'opt_to')),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    const r = p.move(interaction.options.getInteger('from', true), interaction.options.getInteger('to', true));
    if (!r) throw new UserError(t('badPosition'));
    await say(interaction, t('moved', { title: md(trackLabel(r.track)), to: r.to }));
  },
};

export const shuffle = {
  data: cmd('shuffle'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    if (p.queue.length < 2) throw new UserError(t('queueEmpty'));
    p.shuffle();
    await say(interaction, t('shuffled'));
  },
};

export const clear = {
  data: cmd('clear'),
  async execute(interaction, ctx) {
    const p = controlPlayer(interaction, ctx, { current: false });
    requireDj(interaction, ctx.config);
    p.clear();
    await say(interaction, t('cleared'));
  },
};
