// Command registry and interaction routing (slash commands, autocomplete, buttons, select menus).
import { MessageFlags } from 'discord.js';
import { t } from '../ui/i18n.js';
import { handleNowPlayingButton, handleQueueButton } from '../ui/nowPlaying.js';
import * as control from './control.js';
import { handleLocalAll, handleLocalPick, local } from './local.js';
import { handleSearchPick, play, playnext, search } from './play.js';
import { playlist } from './playlist.js';
import * as queueCmds from './queue.js';
import { getPick } from './util.js';

export const commands = [
  play,
  playnext,
  search,
  local,
  control.pause,
  control.resume,
  control.skip,
  control.stop,
  control.leave,
  queueCmds.queue,
  queueCmds.nowplaying,
  queueCmds.remove,
  queueCmds.move,
  queueCmds.shuffle,
  queueCmds.clear,
  control.loop,
  control.volume,
  control.seek,
  control.replay,
  playlist,
  control.autoplay,
];

const byName = new Map(commands.map((c) => [c.data.name, c]));

export const commandJson = () => commands.map((c) => c.data.toJSON());

async function handlePick(interaction, ctx) {
  const [kind, id] = interaction.customId.split(':');
  const pick = getPick(id);
  if (!pick) {
    await interaction.reply({ content: t('expired'), flags: MessageFlags.Ephemeral });
    return;
  }
  if (kind === 'pickall') return handleLocalAll(interaction, ctx, pick);
  if (pick.kind === 'local') return handleLocalPick(interaction, ctx, pick, id);
  return handleSearchPick(interaction, ctx, pick);
}

const components = {
  np: handleNowPlayingButton,
  q: handleQueueButton,
  pick: handlePick,
  pickall: handlePick,
};

/** Show an error to the user (ephemeral where possible); unexpected errors are logged and shown generically. */
async function reportError(interaction, e, ctx) {
  const userFacing = e?.name === 'UserError' || e?.name === 'SourceError';
  if (!userFacing) ctx.log?.(`[interaction] ${interaction.commandName ?? interaction.customId}: ${e?.stack || e}`);
  else if (e.detail) ctx.log?.(`[source] ${e.code}: ${e.detail}`);
  const content = userFacing ? e.userMessage ?? e.message : t('error');
  try {
    if (interaction.deferred || interaction.replied) {
      // A component whose update was deferred: show the error instead of the old menu.
      await interaction.editReply({ content, components: [], embeds: [], allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    ctx.log?.(`[interaction] could not report error: ${err.message}`);
  }
}

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {{manager: any, sources: any, config: any, store: any, log?: Function}} ctx
 */
export async function handleInteraction(interaction, ctx) {
  if (!interaction.inGuild?.() && !interaction.guildId) {
    if (interaction.isRepliable?.()) await interaction.reply({ content: t('guildOnly'), flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  try {
    if (interaction.isAutocomplete()) {
      const cmd = byName.get(interaction.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(interaction, ctx);
      else await interaction.respond([]);
      return;
    }
    if (interaction.isChatInputCommand()) {
      const cmd = byName.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction, ctx);
      return;
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const handler = components[interaction.customId.split(':')[0]];
      if (handler) await handler(interaction, ctx);
    }
  } catch (e) {
    if (interaction.isAutocomplete()) {
      ctx.log?.(`[autocomplete] ${e.message}`);
      await interaction.respond([]).catch(() => {});
      return;
    }
    await reportError(interaction, e, ctx);
  }
}
