// /playlist save|load|list|delete <name>: per-guild playlists in data/playlists.json.
import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { describe, t } from '../ui/i18n.js';
import { UserError, addedText, checkRate, clip, enqueueTracks, isDj, md, requireVoice } from './util.js';

const nameOpt = (auto) => (o) => describe(o.setName('name'), 'opt_name').setRequired(true).setMaxLength(50).setAutocomplete(auto);

export const playlist = {
  data: describe(new SlashCommandBuilder().setName('playlist'), 'playlist')
    .addSubcommand((s) => describe(s.setName('save'), 'playlist_save').addStringOption(nameOpt(true)))
    .addSubcommand((s) => describe(s.setName('load'), 'playlist_load').addStringOption(nameOpt(true)))
    .addSubcommand((s) => describe(s.setName('list'), 'playlist_list'))
    .addSubcommand((s) => describe(s.setName('delete'), 'playlist_delete').addStringOption(nameOpt(true))),

  async execute(interaction, ctx) {
    const store = ctx.store.playlists;
    const g = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const name = interaction.options.getString('name')?.trim();
    const owns = (pl) => pl.savedBy === interaction.user.id || isDj(interaction.member, ctx.config);

    if (sub === 'list') {
      const all = store.list(g);
      if (!all.length) return interaction.reply({ content: t('plNone'), flags: MessageFlags.Ephemeral });
      const lines = all.map((pl) => t('plEntry', { name: md(pl.name), count: pl.tracks.length, by: pl.savedBy }));
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(t('plListTitle')).setDescription(clip(lines.join('\n'), 4096));
      return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    if (sub === 'save') {
      const p = ctx.manager.get(g);
      const tracks = p && !p.destroyed ? [p.current, ...p.queue].filter(Boolean) : [];
      if (!tracks.length) throw new UserError(t('plNothingToSave'));
      const existing = store.get(g, name);
      if (existing && !owns(existing)) throw new UserError(t('plNotOwner'));
      store.save(g, name, tracks, interaction.user.id);
      return interaction.reply({ content: t('plSaved', { name: md(name), count: tracks.length }), allowedMentions: { parse: [] } });
    }
    const pl = store.get(g, name);
    if (!pl) throw new UserError(t('plNotFound', { name: md(name) }));
    if (sub === 'delete') {
      if (!owns(pl)) throw new UserError(t('plNotOwner'));
      store.delete(g, name);
      return interaction.reply({ content: t('plDeleted', { name: md(pl.name) }), allowedMentions: { parse: [] } });
    }
    // load
    requireVoice(interaction);
    checkRate(interaction.user.id, ctx.config);
    await interaction.deferReply();
    const player = await ctx.manager.connect(interaction);
    const res = enqueueTracks(player, pl.tracks, { requestedBy: interaction.user.id, config: ctx.config });
    let text = res.added > 1 ? t('plLoaded', { name: md(pl.name), count: res.added }) : addedText({ ...res, dropped: 0 }, pl.tracks);
    if (res.dropped) text += ` ${t('queueTrimmed', { count: res.dropped })}`;
    await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
  },

  async autocomplete(interaction, ctx) {
    const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
    const names = ctx.store.playlists
      .list(interaction.guildId)
      .filter((pl) => pl.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((pl) => ({ name: clip(`${pl.name} (${pl.tracks.length})`, 100), value: pl.name.slice(0, 100) }));
    await interaction.respond(names);
  },
};
