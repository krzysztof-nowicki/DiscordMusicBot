# DiscordMusicBot: small Linux image (Northflank free plan, any Docker host).
#   docker build -t discord-music-bot .
#   docker run --rm -e DISCORD_TOKEN=... -e GUILD_ID=... discord-music-bot
FROM node:24-bookworm-slim

# ffmpeg (decode + Opus encode), CA certs for HTTPS; curl/unzip only for the downloads below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp (standalone Linux build) and deno (yt-dlp's JS runtime for YouTube) into /app/bin.
# The bot may self-update yt-dlp there at runtime, so the folder belongs to the runtime user.
RUN mkdir -p /app/bin /app/data /app/music \
 && curl -fsSL -o /app/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod 0755 /app/bin/yt-dlp \
 && curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
 && unzip -q /tmp/deno.zip -d /app/bin \
 && chmod 0755 /app/bin/deno \
 && rm /tmp/deno.zip \
 && /app/bin/yt-dlp --version && /app/bin/deno --version \
 && apt-get purge -y curl unzip && apt-get autoremove -y

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
# Optional local library baked into the image (put files in music/ before building).
COPY music ./music

ENV NODE_ENV=production \
    AUDIO_MODE=opus \
    BIN_DIR=/app/bin \
    YTDLP_PATH=/app/bin/yt-dlp \
    DATA_DIR=/app/data \
    MUSIC_DIR=/app/music

RUN chown -R node:node /app/bin /app/data
USER node

# Graceful shutdown on SIGTERM is handled by the bot (leaves voice, kills ffmpeg/yt-dlp).
CMD ["node", "src/index.js"]
