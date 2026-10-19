# Agent P (player & Discord) log

## Done
- src/ui/i18n.js (pl/en + command descriptions with pl localizations), src/store.js (settings.json, playlists.json; atomic writes)
- src/player/voice.js (DAVE join, reconnect/rejoin, 4014/4017), src/player/GuildPlayer.js, src/player/manager.js
- src/commands/{util,play,local,control,queue,playlist,index}.js, src/ui/nowPlaying.js, src/index.js
- Cloud (session 2): stream `type` raw|ogg/opus, Ogg volume = debounced re-create at position; `/play file:` attachment
  (ext + content-type + 100 MB check, passed as resolve(att.url, {attachment:{url,name,size,contentType}}));
  fallbackFrom note "(z SoundCloud)"; src/health.js (PORT → GET /health); src/heartbeat.js + src/healthcheck.js
  (DATA_DIR/heartbeat every 30 s while ready; exit 0 if < 120 s); 10-min resource log when PORT set;
  Dockerfile (no deno, ARG YTDLP_VERSION, NODE_OPTIONS=--max-old-space-size=192, XDG_CACHE_HOME=/app/cache, HEALTHCHECK),
  .dockerignore, music/.gitkeep; setup.ps1 / start.ps1
- Resource limits (config.limits): alone → pause now/auto-resume/leave; idle leave; pause → kill streams after
  PAUSE_KILL_SEC (resume = seek re-create), leave after PAUSE_LEAVE_MIN; MAX_ACTIVE_PLAYERS; NP_UPDATE_SEC;
  PREFETCH_LEAD_SEC (1 ahead only); MAX_PLAYLIST; MAX_QUEUE; PLAY_RATE_COUNT/PLAY_RATE_WINDOW_SEC
- Tests: test/player.test.js (fakes + fake timers + leak check), test/player.e2e.test.js (real ffmpeg, Raw and OggOpus),
  test/commands.test.js (mocked interactions, health, heartbeat). `npm test`: 40/40 green.

## Next
- Real Discord run (needs a token) — never tested against Discord.
- Docker image build untested here (Docker daemon not running).
- Docs (README/DEPLOY_NORTHFLANK/USAGE) are the lead's.

## Design notes / gotchas
- Idle handling: every transition calls _halt(): token++, `resource = null` BEFORE player.stop(), then kill(). The Idle
  listener only advances when `oldState.resource === this.resource`. Late createStream results are killed and dropped.
- Pause state is our own `pauseReason` ('user'|'alone'), not the AudioPlayer status: after a pause-kill the player is
  Idle but the track is still "paused" (suspendedAt holds the position).
- Failure = AudioPlayer error, createStream throw, or < 1 s played from 0 (not live, duration > 2 s). 3 in a row → stop.
- `volume` passed to createStream is a factor (0.6 = 60 %); S must apply it only for ogg/opus streams (raw streams get
  inlineVolume here, so applying it there too would double it).
- Autocomplete answers within 2.5 s; late results still fill the cache. Values > 100 chars / local tracks → `ac:<n>` tokens.
- Python edits on Windows: open(..., newline='') or the file turns CRLF; the Bash tool halves backslashes in heredocs.
- npm test glob is test/*.test.js, so test/helpers/ is not run as tests.
