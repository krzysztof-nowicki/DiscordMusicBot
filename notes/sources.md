# Sources (agent S): status notes

Last update: 2026-10-19. Owner files: `src/sources/**`, `src/tools.js`, `test/sources.test.js`,
`test/live/sources.live.test.js`, `test/fixtures/*`, `setup-tools.ps1`.

## Done
- `track.js`: Track typedef, `makeTrack()`, `SourceError(code, detail)` (localized `.message`/`.userMessage`, codes:
  NOT_FOUND UNSUPPORTED UNAVAILABLE AGE_RESTRICTED BOT_CHECK NO_MATCH NETWORK TOOL_MISSING LOCAL_MISSING STREAM_FAILED).
- `index.js`: public API (resolve, search, createStream, prefetch, localLibrary, ensureTools, makeTrack, SourceError).
- `tools.js`: Windows and Linux. yt-dlp from YTDLP_PATH, else BIN_DIR (downloads `yt-dlp.exe` / `yt-dlp_linux` /
  `_aarch64`), else PATH; `-U` at most once a day if writable (state in DATA_DIR/tools.json). JS runtime = node
  (the bot's own binary) by default; deno only with YTDLP_JS_RUNTIME=deno (downloaded if missing). ffmpeg/ffprobe
  discovery. Cookies: YTDLP_COOKIES_B64 or YTDLP_COOKIES -> 0600 temp copy. `killTree` = `taskkill /T /F` on
  Windows, `process.kill(-pid)` on Linux (children spawned `detached`). `ytdlpSlots` semaphore (YTDLP_CONCURRENCY).
  **All yt-dlp flags: `ytdlpProfile` + `ytdlpBaseArgs()` in tools.js** (env: YTDLP_JS_RUNTIME, YTDLP_FORMAT,
  YTDLP_EXTRACTOR_ARGS, YTDLP_RETRY_EXTRACTOR_ARGS, YTDLP_EXTRA_ARGS, YTDLP_CONCURRENCY, YTDLP_FORCE_IPV4).
- `detect.js` (pure), `resolve.js` (resolve + search), `youtube.js` (innertube search, yt-dlp fallback),
  `ytdlp.js` (JSON, flat playlists, stream info, error mapping, SoundCloud search), `spotify.js` (embed + API +
  matching), `match.js` (scoring), `local.js` (library), `stream.js` (createStream/prefetch), `util.js`.
- Tests: `npm test` 49/49 (9 mine), `npm run test:live` 16/16 on Windows and on Linux (WSL Ubuntu 22.04).
- `setup-tools.ps1`: `Install-MusicBotTools [-WithDeno] [-BinDir]` (dot-source or run). Tested: fresh download,
  update and dot-sourced.

## Next / open
- Real Northflank run: confirm whether YouTube bot-checks the datacenter IP; tune YTDLP_EXTRACTOR_ARGS / cookies.
- A YouTube Music (WEB_REMIX innertube) search would find "- Topic" uploads more often for Spotify matches. Today
  WEB search rarely returns Topic videos, so matches are usually official videos within ±7 s.
- Spotify playlists > 100 tracks without an owner token: no way found (the embed caps at 100; the API needs ownership).

## Gotchas (verified)
- yt-dlp 2026.08.19: YouTube needs a JS runtime (EJS solver v0.8.0 is bundled in the exe). Without one it warns that
  this is "deprecated, some formats may be missing" and still works today. `--no-js-runtimes --js-runtimes node:<node>`
  works with Node 24 (~3.2 s per `-j`). Deno in the same folder as yt-dlp.exe is auto-detected on Windows.
- No PO token or cookies were needed from a residential IP (2026-10). Datacenter IPs: expect "Sign in to confirm
  you're not a bot", which maps to BOT_CHECK -> one retry with player_client=default,android_vr (tv with cookies)
  -> SoundCloud fallback (track.fallback='soundcloud', fallbackFrom='youtube'). Test hook: SOURCES_SIMULATE_BOT_CHECK=1.
- googlevideo direct URLs: `expire=` is ~6 h ahead; no throttling (213 s decoded in 3.7 s). ffmpeg `-ss` before `-i`.
- **Never use `-reconnect_at_eof` on HLS** (YouTube live / SoundCloud m3u8): ffmpeg re-fetches the playlist forever
  and produces no audio. It is only used for icecast-style radio.
- The one-file yt-dlp binary runs as two processes (bootloader + child) on both OSes; a plain kill orphans the
  child. killTree handles it (verified by PID tracking in the live test).
- Spotify embed: `__NEXT_DATA__` -> props.pageProps.state.data.entity {type, name, artists|subtitle, duration ms,
  trackList[] {uri, title, subtitle, duration}}. Playlists are capped at **100** tracks (`playlist.truncated`).
  Artist lists use NBSP after commas (makeTrack folds whitespace).
- Spotify Web API (Feb 2026 Dev Mode): `/playlists/{id}/tracks` -> `/items`, and items only come back for playlists
  the user owns. With client credentials it usually fails, so we fall back to the embed. `/tracks/{id}` and
  `/albums/{id}` (+ paging) work; the batch `/tracks` was removed; search max limit is 10. Untested live: no credentials.
- SomaFM refused our IP (302 to alert.mp3, 403); Radio Paradise / FIP are used in tests.
- The johnvansickle static ffmpeg segfaults on DNS (exit 139) under glibc; use Debian's apt ffmpeg or BtbN builds.
- Flat SoundCloud set entries have no titles, so sets get a full `-J` extraction (~3.5 s for 6 tracks).
- music-metadata pinned to 11.16.1 (12.x was days old on 2026-10-19).
