// Runtime configuration from .env (single source of truth for every module).
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => {
  const v = Number(env(k, ''));
  return Number.isFinite(v) && env(k, '') !== '' ? v : d;
};

export const config = {
  token: env('DISCORD_TOKEN'),
  guildId: env('GUILD_ID'),
  lang: env('LANG_BOT', env('LANG', 'pl')).startsWith('en') ? 'en' : 'pl',
  musicDir: env('MUSIC_DIR', path.join(os.homedir(), 'Music')),
  spotify: { clientId: env('SPOTIFY_CLIENT_ID'), clientSecret: env('SPOTIFY_CLIENT_SECRET') },
  djRole: env('DJ_ROLE'),
  defaultVolume: num('DEFAULT_VOLUME', 60),
  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  ytdlpPath: env('YTDLP_PATH', path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')),
  ytdlpCookies: env('YTDLP_COOKIES'),
  ytdlpCookiesB64: env('YTDLP_COOKIES_B64'),
  ytFallback: env('YT_FALLBACK', 'soundcloud') === 'none' ? 'none' : 'soundcloud',
  audioMode: (env('AUDIO_MODE', process.platform === 'win32' ? 'pcm' : 'opus') === 'pcm') ? 'pcm' : 'opus',
  idleLeaveMin: num('IDLE_LEAVE_MIN', 5),
  aloneLeaveMin: num('ALONE_LEAVE_MIN', 3),
  port: num('PORT', 0),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  binDir: path.resolve(ROOT, env('BIN_DIR', 'bin')),
};
