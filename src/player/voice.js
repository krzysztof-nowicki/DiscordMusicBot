// Voice connection with DAVE E2EE and reconnect handling (pattern from ApocalypseChat/discord_bridge/session.js).
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
} from '@discordjs/voice';

const READY_TIMEOUT_MS = 20_000;
const MAX_REJOINS = 5;
const DAVE_FAIL_WINDOW_MS = 10_000;
const DAVE_FAIL_REJOIN = 50;
const REJOIN_COOLDOWN_MS = 60_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Join a voice channel and resolve once the connection is Ready.
 * Network blips and DAVE glitches are handled here; when the connection is gone for good it is destroyed
 * and `onGone()` is called (the GuildPlayer then cleans up).
 * @param {import('discord.js').VoiceBasedChannel} channel
 * @param {{log?: (m: string) => void, onGone?: () => void}} [opts]
 */
export async function joinChannel(channel, { log = console.log, onGone = () => {} } = {}) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true, // a music bot never listens
    selfMute: false,
    daveEncryption: true, // DAVE E2EE, mandatory on Discord since March 2026 (close code 4017 without it)
    debug: true, // DAVE diagnostics arrive as debug lines
  });

  let daveFails = [];
  let lastRejoin = 0;
  let readyWatch = false;

  connection.on('error', (e) => log(`[voice] error: ${e.message}`));
  connection.on('debug', (m) => {
    if (!m.includes('[DAVE]')) return;
    if (!/fail|error/i.test(m)) return;
    const now = Date.now();
    daveFails = daveFails.filter((t) => now - t < DAVE_FAIL_WINDOW_MS);
    daveFails.push(now);
    if (daveFails.length >= DAVE_FAIL_REJOIN && now - lastRejoin > REJOIN_COOLDOWN_MS) {
      lastRejoin = now;
      daveFails = [];
      log('[voice] persistent DAVE failures, rejoining');
      try {
        connection.rejoin();
      } catch (e) {
        log(`[voice] rejoin failed: ${e.message}`);
      }
    }
  });

  connection.on('stateChange', async (oldS, newS) => {
    if (oldS.status !== newS.status) log(`[voice] ${oldS.status} -> ${newS.status}`);
    if (newS.status === VoiceConnectionStatus.Disconnected) {
      if (newS.reason === VoiceConnectionDisconnectReason.WebSocketClose && newS.closeCode === 4017) {
        log('[voice] close code 4017: DAVE (E2EE) is required; check @snazzah/davey is installed');
      }
      if (newS.reason === VoiceConnectionDisconnectReason.WebSocketClose && newS.closeCode === 4014) {
        // 4014 = moved to another channel (reconnects by itself) or kicked (does not).
        try {
          await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        } catch {
          safeDestroy(connection);
        }
      } else if (connection.rejoinAttempts < MAX_REJOINS) {
        await wait((connection.rejoinAttempts + 1) * 3_000);
        if (connection.state.status === VoiceConnectionStatus.Disconnected) connection.rejoin();
      } else {
        log('[voice] giving up after repeated reconnects');
        safeDestroy(connection);
      }
    } else if (newS.status === VoiceConnectionStatus.Destroyed) {
      onGone();
    } else if (
      !readyWatch &&
      (newS.status === VoiceConnectionStatus.Connecting || newS.status === VoiceConnectionStatus.Signalling)
    ) {
      // Don't hang forever in Connecting/Signalling (known @discordjs/voice failure mode).
      readyWatch = true;
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          log('[voice] stuck while connecting');
          safeDestroy(connection);
        }
      } finally {
        readyWatch = false;
      }
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (e) {
    safeDestroy(connection);
    throw e;
  }
  return connection;
}

export function safeDestroy(connection) {
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      connection.destroy();
    } catch {
      /* already gone */
    }
  }
}
