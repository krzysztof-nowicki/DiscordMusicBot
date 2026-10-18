# DiscordMusicBot — design contract

A self-hosted Discord music bot for Windows that plays from YouTube, Spotify (metadata → YouTube match),
SoundCloud, Bandcamp, Twitch/radio streams, any yt-dlp-supported site, direct audio URLs and **local files**.

Node 24 portable (`.node/`) · discord.js 14.27 · @discordjs/voice 0.19.2 + @snazzah/davey (Discord DAVE
E2EE voice, mandatory since March 2026) · `yt-dlp` standalone exe in `bin/` (self-updating) · ffmpeg
(from PATH, `C:\ffmpeg\bin`; `FFMPEG_PATH` env overrides). Same proven stack as
`ApocalypseChat/discord_bridge`; that folder's playback.js is reference code for AudioPlayer handling.

```
/play query|url ──► sources/resolve.js ──► Track[] ──► GuildPlayer queue ──► sources/stream.js
                     youtube│spotify│soundcloud│local│http│generic        yt-dlp ─► ffmpeg ─► s16le 48k stereo
                                                                         (file/http: ffmpeg only)
                                                                         ─► AudioResource(Raw, inlineVolume) ─► VoiceConnection
```

## Ownership

| Files | Owner |
|---|---|
| `src/sources/**`, `src/tools.js` (yt-dlp/ffmpeg discovery, download + self-update), `test/sources*.test.js`, the tools part of `setup.ps1` | **S** (sources) |
| `src/index.js`, `src/player/**`, `src/commands/**`, `src/ui/**`, `src/store.js`, `test/player*.test.js`, `test/commands*.test.js`, `README.md`, `start.ps1`, the rest of `setup.ps1` | **P** (player and Discord) |
| `package.json`, `src/config.js`, `DESIGN.md`, `.gitignore`, `.env.example` | lead. Agents may add deps to package.json; tell the lead. |

## Track (shared type, `src/sources/track.js`, written by S first)

```js
/** @typedef {Object} Track
 * @property {string} id            stable key, e.g. "yt:dQw4w9WgXcQ", "sp:4uLU6hMCjMI75M1A2tKUQC", "local:<relpath>"
 * @property {string} title
 * @property {string} [artist]
 * @property {number|null} durationSec   null = live / unknown
 * @property {string} [url]          canonical page URL (shown as a link)
 * @property {string} [thumbnail]
 * @property {'youtube'|'spotify'|'soundcloud'|'bandcamp'|'local'|'http'|'radio'|'generic'} source
 * @property {boolean} isLive
 * @property {string} [requestedBy]  Discord user id (set by the player)
 */
```

## Sources API (S) — `src/sources/index.js`

```js
export async function resolve(query, { limit = 1, playlistLimit = 500 } = {}) // -> { tracks: Track[], playlist?: {title, url, count} }
//   URL → detect the source; playlists/albums expand; plain text → YouTube search (best match, prefer "Official Audio"/Topic)
//   "sc:", "yt:" and "local:" prefixes force a source; "spotify:track:…" URIs are supported
export async function search(query, { source = 'youtube', limit = 5 } = {}) // -> Track[]   (fast: used by autocomplete, < 2.5 s, cached)
export async function createStream(track, { seekSec = 0, signal } = {})    // -> { stream: Readable s16le 48k stereo, kill(): void }
//   Spotify tracks resolve to a YouTube match lazily here (cache the mapping); errors → throw SourceError with a user-friendly Polish message
export async function prefetch(track)                                        // optional warm-up (resolve stream URL ahead)
export function localLibrary()                                               // -> { scan(), search(q, limit), list(dir) } over MUSIC_DIR
```

Requirements S must verify live:
- yt-dlp 2026 on YouTube: check whether an external JS runtime (Deno) or PO tokens are now required. If
  Deno is needed, download its standalone exe into `bin/` too and pass `--js-runtimes`. Prove it with a real
  YouTube video and a playlist.
- Spotify without user login: use the Web API client-credentials flow if `SPOTIFY_CLIENT_ID/SECRET` are set.
  Otherwise fall back to the public embed page (`open.spotify.com/embed/{track|album|playlist}/{id}`, which carries
  JSON). Prove it with a real track, album and playlist. Match to YouTube by "artist - title" plus a duration
  tolerance of ±7 s, preferring Topic/Official Audio.
- SoundCloud, Bandcamp, an internet radio stream (e.g. an icecast .mp3 URL), and a direct .mp3 URL.
- Local: the `MUSIC_DIR` env var (default `%USERPROFILE%\Music`), recursive scan, tags via `music-metadata`, cached
  index in `data/library.json`, accent-insensitive fuzzy search. Formats: mp3/flac/ogg/opus/m4a/wav/aac/wma.
- Seek: yt-dlp `--download-sections` is slow, so use ffmpeg `-ss` on the direct stream URL from `yt-dlp -g`,
  re-resolved when the URL expires. Kill all child processes when skipping or stopping (no zombie ffmpeg on
  Windows; use `taskkill /T` if needed).

## Player and Discord (P)

Slash commands (guild-registered if `GUILD_ID` is set, else global):
- `/play <query|url>`: autocomplete via `search()`; also local files. `/playnext`, `/search <q>` (select menu of 5).
- `/local [query]`: browse/search the music folder (select menu); `/local all` queues a folder.
- `/pause` `/resume` `/skip [n]` `/stop` (clears the queue) `/leave`
- `/queue [page]`, `/nowplaying`, `/remove <pos>`, `/move <from> <to>`, `/shuffle`, `/clear`
- `/loop off|track|queue`, `/volume <0-200>` (persisted per guild), `/seek <mm:ss>`, `/replay`
- `/playlist save|load|list|delete <name>`: local JSON in `data/playlists.json`.
- `/autoplay on|off`: when the queue ends, queue a related YouTube track (optional, best effort).

Behaviour:
- **One GuildPlayer per guild:** queue, history (for `/replay`), loop modes, and prefetch of the next track a few
  seconds before the end.
- **Auto-leave** after 3 min alone in the channel or 5 min idle.
- **Reconnect** handling on network or DAVE glitches.
- **Now-playing message:** an embed with title link, artist, duration progress, thumbnail, requester, source
  icon and queue length, plus buttons ⏯ ⏭ ⏹ 🔁 🔀. Edit it in place; don't spam.
- **Permissions:** an optional `DJ_ROLE` env var restricts the destructive commands (skip others' tracks,
  stop, clear, volume); anyone can add tracks.
- **Messages:** in Polish by default (`LANG=pl|en`), short and friendly.
- **Robustness:** one bad track never kills the queue. Log the error, post a short notice and play the next track.

## Config (`src/config.js`, lead)

`.env`: `DISCORD_TOKEN` (required), `GUILD_ID`, `MUSIC_DIR`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `DJ_ROLE`,
`LANG`, `DEFAULT_VOLUME` (=60), `FFMPEG_PATH`, `YTDLP_PATH`, `IDLE_LEAVE_MIN`, `ALONE_LEAVE_MIN`, `YTDLP_COOKIES`
(an optional cookies.txt path for age-restricted videos).

## Testing

- Offline unit tests with `node --test`: queue logic, loop and shuffle, URL detection, Spotify embed parsing from saved
  fixtures, and duration matching.
- Live source tests (`npm run test:live`): real YouTube, Spotify, SoundCloud, radio and local, decoding about 3 s of PCM each.
- A player test with a mocked VoiceConnection: an end-to-end run where real ffmpeg decodes a local mp3 into an AudioPlayer.
- It can't be tested on real Discord without a token; say so in reports.
