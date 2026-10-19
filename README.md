Created mostly using Claude Code </br>
# DiscordMusicBot

A self-hosted Discord music bot. It plays **YouTube, Spotify** (matched to YouTube/SoundCloud), **SoundCloud, Bandcamp,
internet radio, Twitch, ~1000 other sites** (via yt-dlp), **direct audio links, uploaded files and your local music
folder**. It has slash commands with autocomplete, a *Now playing* card with buttons, loop/shuffle/seek/volume, saved
playlists, an optional DJ role, and Polish or English messages. Built-in limits keep it light: it auto-leaves when
idle, alone or paused too long.

| Guide | For |
|---|---|
| **README.md** (this file) | running it on your Windows PC |
| **[USAGE.md](USAGE.md)** | creating and inviting the bot, and **every command with examples** (links, files, choices) |
| **[DEPLOY_NORTHFLANK.md](DEPLOY_NORTHFLANK.md)** | running it 24/7 on Northflank's free plan |
| [DESIGN.md](DESIGN.md) / [STATUS.md](STATUS.md) | architecture and progress log |

Stack: Node 24, discord.js 14.27, @discordjs/voice 0.19.2 with **DAVE** end-to-end-encrypted voice (required by Discord
since March 2026), yt-dlp (self-updating) and ffmpeg.

---

## Quick start (Windows)

1. **Create the bot and invite it.** Follow [USAGE.md](USAGE.md) sections 1–2. You need the **bot token**.
2. **Install:**
   ```powershell
   cd C:\Users\marom\PycharmProjects\DiscordMusicBot
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
   The script:
   - checks Node.js 22.12+; if it's missing it offers `winget install OpenJS.NodeJS.LTS` or a portable Node in `.node\`;
   - runs `npm install`;
   - downloads **yt-dlp** into `bin\`;
   - checks **ffmpeg**: you already have it in `C:\ffmpeg\bin`, otherwise `winget install Gyan.FFmpeg`.
3. **Configure:** copy `.env.example` to `.env` and fill in at least:
   ```ini
   DISCORD_TOKEN=paste-your-bot-token
   GUILD_ID=your-server-id        # commands appear instantly (optional)
   MUSIC_DIR=C:\Users\marom\Music # local library (optional, this is the default)
   LANG_BOT=pl                    # or en
   ```
4. **Run:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start.ps1
   ```
   Keep the window open. Ctrl+C stops the bot cleanly; it leaves voice and stops all ffmpeg/yt-dlp processes.
5. **In Discord:** join a voice channel and type `/play query: lofi hip hop`. All commands are in [USAGE.md](USAGE.md).

Only you have the token. `.env` is git-ignored and never leaves your PC.

## Polski — szybki start
1. Utwórz bota i zaproś go na serwer: [USAGE.md](USAGE.md), sekcje 1–2. Skopiuj **token**.
2. `powershell -ExecutionPolicy Bypass -File .\setup.ps1` instaluje Node (lub wersję przenośną), pakiety i yt-dlp.
3. Skopiuj `.env.example` jako `.env`, a potem wpisz `DISCORD_TOKEN=` i opcjonalnie `GUILD_ID=` (komendy pojawią się od razu).
4. `powershell -ExecutionPolicy Bypass -File .\start.ps1` uruchamia bota (okno zostaw otwarte).
5. Na Discordzie wejdź na kanał głosowy i wpisz `/play query: <tytuł albo link>`. Wszystkie komendy z przykładami są w USAGE.md.
6. Żeby bot działał 24/7 bez komputera, użyj [DEPLOY_NORTHFLANK.md](DEPLOY_NORTHFLANK.md).

## Configuration (`.env`)
Everything is optional except `DISCORD_TOKEN`. See `.env.example` for the full list with comments.

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | – | bot token (**required**) |
| `GUILD_ID` | – | register commands on one server (instant); empty = global (up to 1 h) |
| `LANG_BOT` | `pl` | `pl` or `en` messages |
| `MUSIC_DIR` | `%USERPROFILE%\Music` | local library for `/local` and `local:` searches |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | – | optional Spotify API keys (full albums); without them the public embed pages are used |
| `DJ_ROLE` | – | role name or ID that may skip others' songs, stop, leave, clear and change volume |
| `DEFAULT_VOLUME` | `60` | starting volume % per server |
| `YTDLP_COOKIES` / `YTDLP_COOKIES_B64` | – | YouTube cookies (path / base64) for age-restricted videos or blocked servers |
| `YT_FALLBACK` | `soundcloud` | what to do when YouTube blocks the server: `soundcloud` or `none` |
| `AUDIO_MODE` | `pcm` (Windows) / `opus` (Linux) | `opus` = ffmpeg encodes Opus once (lowest CPU) |
| `ALONE_LEAVE_MIN` / `IDLE_LEAVE_MIN` / `PAUSE_LEAVE_MIN` | 3 / 5 / 10 | auto-leave timers |
| `PAUSE_KILL_SEC` | 60 | stop the audio processes after this long paused (resume continues at the same spot) |
| `MAX_ACTIVE_PLAYERS` | 10 (Windows) / 3 (Linux) | servers playing at once |
| `NP_UPDATE_SEC` | 30 | *Now playing* card refresh interval |
| `MAX_QUEUE` / `MAX_PLAYLIST` | 500 / 200 | queue and playlist import caps |
| `PLAY_RATE_COUNT` / `PLAY_RATE_WINDOW_SEC` | 5 / 10 | per-user `/play` rate limit |
| `PORT` | – | if set, serves `GET /health` (only for hosts that require a port) |

## How it plays each source
- **YouTube and other sites:** yt-dlp finds the audio stream, and ffmpeg decodes it for Discord. yt-dlp updates itself
  at most once a day, because YouTube changes often.
- **Spotify:** its audio is DRM-protected, so the bot reads the title, artist and length from Spotify and plays the
  matching recording from YouTube. It checks the length to within ±7 s and prefers "Topic"/official uploads, and it
  caches the matches. Playlists give at most 100 songs (a Spotify limit since February 2026).
- **Local and uploaded files:** ffmpeg plays them directly (mp3, flac, ogg, opus, m4a, wav, aac, wma, webm, mp4).
- **Radio and direct links:** streamed by ffmpeg, with automatic reconnect.

## Development
```powershell
$env:PATH = "$PWD\.node\node-v24.22.0-win-x64;$env:PATH"
npm test            # offline tests (player, commands, sources)
npm run test:live   # real network: YouTube, Spotify, SoundCloud, radio, local
docker build -t discord-music-bot .   # the same image Northflank builds
```

## Legal
For personal use on your own servers. Downloading or streaming content may conflict with the terms of service of
YouTube, Spotify and other sites. You're responsible for how you use it.
