// /local search [query] (search or browse MUSIC_DIR with a select menu) and /local all [folder] (queue a folder).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { describe, t } from '../ui/i18n.js';
import { UserError, addedText, clip, fmtTime, md, requireVoice, storePick, trackLabel, updatePick } from './util.js';

const FOLDER_MAX_TRACKS = 500;

const baseName = (dir) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
const parentOf = (dir) => {
  const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
  return i < 0 ? '' : dir.slice(0, i);
};

/** Select menu (max 25 options): ⬆ up, folders, then tracks. */
function menuPayload(id, pick) {
  const options = [];
  if (pick.mode === 'browse' && pick.dir) options.push({ label: t('localUp'), value: 'up' });
  pick.dirs.forEach((d, i) => options.push({ label: clip(`📁 ${baseName(d)}`, 100), value: `d:${i}` }));
  pick.tracks.forEach((tr, i) =>
    options.push({
      label: clip(trackLabel(tr), 100),
      description: tr.durationSec ? fmtTime(tr.durationSec) : undefined,
      value: `t:${i}`,
      emoji: '💾',
    }),
  );
  const rows = [];
  if (options.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`pick:${id}`).setPlaceholder(t('searchPlaceholder')).addOptions(options.slice(0, 25)),
      ),
    );
  }
  if (pick.mode === 'browse') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pickall:${id}`).setLabel(t('localAddAll')).setEmoji('➕').setStyle(ButtonStyle.Primary),
      ),
    );
  }
  const where = pick.mode === 'browse' ? pick.dir || t('localRoot') : t('localRoot');
  return { content: t('localPrompt', { dir: md(where) }), components: rows, allowedMentions: { parse: [] } };
}

async function listing(ctx, dir) {
  const r = (await ctx.sources.localLibrary().list(dir)) ?? {};
  const dirs = (r.dirs ?? []).slice(0, 24);
  const tracks = (r.tracks ?? []).slice(0, Math.max(0, 24 - dirs.length));
  return { dir: r.dir ?? dir, dirs, tracks };
}

async function queueFolder(interaction, ctx, dir) {
  const r = (await ctx.sources.localLibrary().list(dir, { recursive: true })) ?? {};
  const tracks = (r.tracks ?? []).slice(0, FOLDER_MAX_TRACKS);
  if (!tracks.length) throw new UserError(t('localFolderEmpty'));
  const player = await ctx.manager.connect(interaction);
  const res = player.enqueue(tracks, { requestedBy: interaction.user.id });
  return addedText(res, tracks, { title: dir ? baseName(dir) : t('localRoot') });
}

export const local = {
  data: describe(new SlashCommandBuilder().setName('local'), 'local')
    .addSubcommand((s) =>
      describe(s.setName('search'), 'local_search').addStringOption((o) => describe(o.setName('query'), 'opt_localq')),
    )
    .addSubcommand((s) =>
      describe(s.setName('all'), 'local_all').addStringOption((o) => describe(o.setName('folder'), 'opt_folder').setAutocomplete(true)),
    ),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'all') {
      requireVoice(interaction);
      await interaction.deferReply();
      const text = await queueFolder(interaction, ctx, interaction.options.getString('folder') ?? '');
      await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
      return;
    }
    const query = interaction.options.getString('query')?.trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let pick;
    if (query) {
      const tracks = ((await ctx.sources.localLibrary().search(query, 25)) ?? []).slice(0, 25);
      pick = { kind: 'local', mode: 'search', userId: interaction.user.id, dir: '', dirs: [], tracks };
    } else {
      pick = { kind: 'local', mode: 'browse', userId: interaction.user.id, ...(await listing(ctx, '')) };
    }
    if (!pick.tracks.length && !pick.dirs.length) throw new UserError(t('localEmpty'));
    const id = storePick(pick);
    await interaction.editReply(menuPayload(id, pick));
  },

  /** Folder names for /local all. */
  async autocomplete(interaction, ctx) {
    const typed = String(interaction.options.getFocused() ?? '').trim();
    const lower = typed.toLowerCase();
    try {
      const lib = ctx.sources.localLibrary();
      const base = parentOf(typed);
      const [here, root] = await Promise.all([lib.list(base), base ? lib.list('') : null]);
      const dirs = [...new Set([...(here?.dirs ?? []), ...(root?.dirs ?? [])])].filter((d) => d.toLowerCase().includes(lower));
      await interaction.respond(dirs.slice(0, 25).map((d) => ({ name: clip(d, 100), value: d.slice(0, 100) })));
    } catch (e) {
      ctx.log?.(`[local autocomplete] ${e.message}`);
      await interaction.respond([]).catch(() => {});
    }
  },
};

/** Select menu answer for /local: browse into a folder, go up, or enqueue a track (menu stays for more picks). */
export async function handleLocalPick(interaction, ctx, pick, id) {
  const v = interaction.values[0];
  if (v === 'up' || v.startsWith('d:')) {
    const dir = v === 'up' ? parentOf(pick.dir) : pick.dirs[Number(v.slice(2))];
    if (dir == null) throw new UserError(t('expired'));
    const next = { mode: 'browse', ...(await listing(ctx, dir)) };
    updatePick(id, next);
    await interaction.update(menuPayload(id, { ...pick, ...next }));
    return;
  }
  const tr = pick.tracks[Number(v.slice(2))];
  if (!tr) throw new UserError(t('expired'));
  requireVoice(interaction);
  await interaction.deferUpdate();
  const player = await ctx.manager.connect(interaction);
  const res = player.enqueue([tr], { requestedBy: interaction.user.id });
  await interaction.editReply({ ...menuPayload(id, pick), content: addedText(res, [tr]) });
}

/** "➕ Add the whole folder" button under a /local browse menu. */
export async function handleLocalAll(interaction, ctx, pick) {
  requireVoice(interaction);
  await interaction.deferUpdate();
  const text = await queueFolder(interaction, ctx, pick.dir ?? '');
  await interaction.editReply({ content: text, components: [] });
}
