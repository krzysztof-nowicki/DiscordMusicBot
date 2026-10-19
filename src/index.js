// DiscordMusicBot entry point: Discord client, slash-command registration, interaction routing, shutdown.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import * as sources from './sources/index.js';
import { settings, playlists } from './store.js';
import { PlayerManager } from './player/manager.js';
import { commandJson, handleInteraction } from './commands/index.js';
import { startHealthServer } from './health.js';

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

if (!config.token) {
  console.error(
    'DISCORD_TOKEN is missing.\n' +
      '  1. Copy .env.example to .env (setup.ps1 does this for you).\n' +
      '  2. Paste your bot token from https://discord.com/developers/applications -> your app -> Bot -> Reset Token.\n' +
      'See README.md, "Setup".',
  );
  process.exit(1);
}

log(`voice dependency report:\n${generateDependencyReport()}`);
log(`audio mode: ${config.audioMode}, data: ${config.dataDir}, music: ${config.musicDir}`);

// Guilds + GuildVoiceStates is all a slash-command music bot needs (no privileged intents).
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const manager = new PlayerManager({ sources, config, settings, log });
const ctx = { manager, sources, config, store: { settings, playlists }, log };

let health = null;
if (config.port > 0) {
  startHealthServer(config.port, () => ({
    discord: client.isReady() ? 'ready' : 'connecting',
    guilds: client.guilds.cache.size,
    voiceConnections: manager.players.size,
    playing: [...manager.players.values()].filter((p) => p.current && !p.paused).length,
    audioMode: config.audioMode,
  }))
    .then((s) => {
      health = s;
      log(`health endpoint on :${config.port}/health`);
    })
    .catch((e) => log(`health server failed on port ${config.port}: ${e.message}`));
}

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag} (${c.guilds.cache.size} servers)`);
  try {
    if (config.guildId) {
      await c.application.commands.set(commandJson(), config.guildId);
      log(`slash commands registered in guild ${config.guildId}`);
    } else {
      await c.application.commands.set(commandJson());
      log('slash commands registered globally (can take up to an hour to show up; set GUILD_ID for instant)');
    }
  } catch (e) {
    log(`slash command registration failed: ${e.message}`);
  }
  // yt-dlp / deno download + self-update; playback of local files works without it.
  Promise.resolve()
    .then(() => sources.ensureTools?.())
    .then(() => log('tools ready'))
    .catch((e) => log(`tool setup failed (YouTube etc. may not work): ${e.detail || e.message}`));
  sources
    .localLibrary()
    .scan()
    .then((n) => log(`local library: ${n} files in ${config.musicDir}`))
    .catch((e) => log(`local library scan failed: ${e.message}`));
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, ctx).catch((e) => log(`interaction failed: ${e?.stack || e}`));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => manager.onVoiceStateUpdate(oldState, newState, client.user?.id));

client.on(Events.Error, (e) => log(`[discord] ${e.message}`));
client.on(Events.Warn, (m) => log(`[discord] warn: ${m}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => log(`uncaught exception: ${e?.stack || e}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  manager.destroyAll(); // kills every yt-dlp/ffmpeg stream and leaves voice
  health?.close();
  await client.destroy().catch(() => {});
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown); // Ctrl+Break / console close on Windows

client.login(config.token).catch((e) => {
  console.error(`Discord login failed: ${e.message}`);
  if (/token/i.test(e.message)) console.error('Check DISCORD_TOKEN in .env (Developer Portal -> Bot -> Reset Token).');
  process.exit(1);
});
