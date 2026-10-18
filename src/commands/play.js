// /play, /playnext (with autocomplete over search() + the local library) and /search (select menu of 5).
import { ActionRowBuilder, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { describe, t } from '../ui/i18n.js';
import { SOURCE_EMOJI, UserError, addedText, clip, fmtTime, md, requireVoice, storePick, trackLabel } from './util.js';

export const AUTOCOMPLETE_BUDGET_MS = 2_500; // Discord drops autocomplete answers after 3 s
const AC_CACHE_MAX = 200;
const TOKEN_MAX = 1_000;

/** query (lowercase) -> choices; filled even when the answer was too late for the keystroke that asked. */
const acCache = new Map();
/** "ac:<n>" -> Track picked from autocomplete (values are limited to 100 chars) */
const tokens = new Map();
let tokenSeq = 0;

function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

function choiceFor(track) {
  const dur = track.isLive ? 'LIVE' : track.durationSec ? fmtTime(track.durationSec) : '';
  const name = clip(`${SOURCE_EMOJI[track.source] ?? '🎵'} ${trackLabel(track)}${dur ? ` (${dur})` : ''}`, 100);
  let value = track.url;
  if (!value || value.length > 100 || track.source === 'local') {
    value = `ac:${++tokenSeq}`;
    lruSet(tokens, value, track, TOKEN_MAX);
  }
  return { name, value };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/** Choices from the youtube + local searches, answering within the budget with whatever finished in time. */
export async function playAutocomplete(interaction, ctx, budgetMs = AUTOCOMPLETE_BUDGET_MS) {
  const q = String(interaction.options.getFocused() ?? '').trim();
  const respond = (choices) => interaction.respond(choices.slice(0, 25)).catch((e) => ctx.log?.(`[autocomplete] ${e.message}`));
  if (q.length < 2) return respond([]);
  if (/^(https?:\/\/|yt:|sc:|local:|spotify:)/i.test(q)) return respond(q.length <= 100 ? [{ name: clip(q, 100), value: q }] : []);
  const key = q.toLowerCase();
  if (acCache.has(key)) return respond(acCache.get(key));

  const got = { yt: null, local: null };
  const yt = Promise.resolve()
    .then(() => ctx.sources.search(q, { limit: 5 }))
    .then((r) => (got.yt = r ?? []))
    .catch(() => (got.yt = []));
  const local = Promise.resolve()
    .then(() => ctx.sources.localLibrary().search(q, 5))
    .then((r) => (got.local = r ?? []))
    .catch(() => (got.local = []));
  const build = () => [...(got.yt ?? []), ...(got.local ?? [])].map(choiceFor);
  const all = Promise.all([yt, local]).then(() => {
    const choices = build();
    lruSet(acCache, key, choices, AC_CACHE_MAX);
    return choices;
  });

  const done = await Promise.race([all.then(() => true), sleep(budgetMs).then(() => false)]);
  if (done) return respond(acCache.get(key));
  // Too slow: partial results, or the longest cached prefix of this query.
  let choices = build();
  if (!choices.length) {
    for (let i = key.length - 1; i >= 2 && !choices.length; i--) choices = acCache.get(key.slice(0, i)) ?? [];
  }
  return respond(choices);
}

async function resolveQuery(query, ctx) {
  if (tokens.has(query)) return { tracks: [tokens.get(query)] };
  if (/^ac:\d+$/.test(query)) throw new UserError(t('expired'));
  return ctx.sources.resolve(query, { limit: 1 });
}

async function playCommand(interaction, ctx, next) {
  const query = interaction.options.getString('query', true).trim();
  requireVoice(interaction);
  await interaction.deferReply();
  const player = await ctx.manager.connect(interaction);
  const { tracks = [], playlist } = (await resolveQuery(query, ctx)) ?? {};
  if (!tracks.length) throw new UserError(t('notFound'));
  const res = player.enqueue(tracks, { requestedBy: interaction.user.id, next });
  const text =
    next && tracks.length === 1 && !res.startedNow ? t('addedNext', { title: md(trackLabel(tracks[0])) }) : addedText(res, tracks, playlist);
  await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
}

const queryOption = (o) => describe(o.setName('query'), 'opt_query').setRequired(true).setAutocomplete(true);

export const play = {
  data: describe(new SlashCommandBuilder().setName('play'), 'play').addStringOption(queryOption),
  execute: (i, ctx) => playCommand(i, ctx, false),
  autocomplete: playAutocomplete,
};

export const playnext = {
  data: describe(new SlashCommandBuilder().setName('playnext'), 'playnext').addStringOption(queryOption),
  execute: (i, ctx) => playCommand(i, ctx, true),
  autocomplete: playAutocomplete,
};

export const search = {
  data: describe(new SlashCommandBuilder().setName('search'), 'search')
    .addStringOption((o) => describe(o.setName('query'), 'opt_query').setRequired(true))
    .addStringOption((o) =>
      describe(o.setName('source'), 'opt_source').addChoices({ name: 'YouTube', value: 'youtube' }, { name: 'SoundCloud', value: 'soundcloud' }),
    ),
  async execute(interaction, ctx) {
    const query = interaction.options.getString('query', true).trim();
    const source = interaction.options.getString('source') ?? 'youtube';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tracks = ((await ctx.sources.search(query, { source, limit: 5 })) ?? []).slice(0, 5);
    if (!tracks.length) throw new UserError(t('notFound'));
    const id = storePick({ kind: 'search', userId: interaction.user.id, tracks });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`pick:${id}`)
      .setPlaceholder(t('searchPlaceholder'))
      .addOptions(
        tracks.map((tr, i) => ({
          label: clip(trackLabel(tr), 100),
          description: clip(`${tr.isLive ? 'LIVE' : fmtTime(tr.durationSec)} · ${tr.source}`, 100),
          value: `t:${i}`,
          emoji: SOURCE_EMOJI[tr.source] ?? '🎵',
        })),
      );
    await interaction.editReply({ content: t('searchPrompt', { query: md(clip(query, 100)) }), components: [new ActionRowBuilder().addComponents(menu)] });
  },
};

/** Select menu answer for /search: enqueue the chosen track. */
export async function handleSearchPick(interaction, ctx, pick) {
  const tr = pick.tracks[Number(interaction.values[0].slice(2))];
  if (!tr) throw new UserError(t('expired'));
  requireVoice(interaction);
  await interaction.deferUpdate();
  const player = await ctx.manager.connect(interaction);
  const res = player.enqueue([tr], { requestedBy: interaction.user.id });
  await interaction.editReply({ content: addedText(res, [tr]), components: [] });
}

