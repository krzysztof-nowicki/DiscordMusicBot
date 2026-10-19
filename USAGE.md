# Using the music bot on Discord

This guide covers creating the bot, inviting it to your server, and every command with examples: links, files and
choices. For running it, see **README.md** (on your PC) or **DEPLOY_NORTHFLANK.md** (24/7 in the cloud).

---

## 1. Create the bot (once)
1. Open <https://discord.com/developers/applications>, click **New Application**, name it (e.g. `Muzyczny`) and click **Create**.
2. In the left menu, open **Bot**:
   - Set the avatar and username if you like.
   - Click **Reset Token**, then **Copy**. This is your **`DISCORD_TOKEN`**. Keep it secret; anyone with it controls your bot.
   - **Privileged Gateway Intents:** you don't need to turn any on. The bot uses only slash commands.
   - **Public Bot:** turn it **off** if only you should be able to invite it.
3. In the left menu, open **General Information** and copy the **Application ID**. You need it for the invite link.

## 2. Invite it to your server
Open this link in your browser, after replacing `YOUR_APPLICATION_ID`:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=36719616
```

`36719616` covers the bot's permissions: View Channels, Send Messages, Embed Links, Connect, Speak and Use Voice
Activity. Pick your server, click **Authorise**, and solve the captcha.

**Instant commands (recommended):** in Discord, go to *User Settings → Advanced* and turn on **Developer Mode**. Then
right-click your server icon, choose **Copy Server ID**, and put it in `GUILD_ID`. Without `GUILD_ID` the commands are
global and can take up to an hour to appear the first time.

**Private voice channels:** the bot's role needs **Connect** and **Speak** in the channel you want it in.

---

## 3. Playing music

Join a voice channel first. The bot joins *your* channel.

### `/play` — the main command
`/play` has two optional fields, and you use **one** of them:

| Option | What to put there |
|---|---|
| `query` | a **link** or **search words**. While you type, a list of suggestions appears (YouTube results + songs from the local music folder). Pick one, or just press Enter. |
| `file` | an **audio file** from your computer. Click the field, choose the file, and press Enter. |

**Examples:**

| You type | What happens |
|---|---|
| `/play query: never gonna give you up` | searches YouTube and plays the best match (prefers "Official Audio" / "Topic" uploads) |
| `/play query: https://www.youtube.com/watch?v=dQw4w9WgXcQ` | plays that video's audio |
| `/play query: https://www.youtube.com/playlist?list=PL...` | queues the whole playlist (max 200 tracks) |
| `/play query: https://music.youtube.com/watch?v=...` | YouTube Music works too |
| `/play query: https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC` | reads the Spotify song and plays the same song from YouTube |
| `/play query: https://open.spotify.com/album/...` | queues the whole album |
| `/play query: https://open.spotify.com/playlist/...` | queues the playlist, **up to its first 100 songs** (a Spotify limit since Feb 2026, even with Spotify keys) |
| `/play query: https://soundcloud.com/artist/track` | SoundCloud track or set |
| `/play query: https://artist.bandcamp.com/track/...` | Bandcamp |
| `/play query: https://stream.example.com/radio.mp3` | internet radio or any direct audio link (plays until you skip) |
| `/play query: https://www.twitch.tv/...` | live streams, and roughly 1000 other sites supported by yt-dlp |
| `/play query: sc: lofi beats` | `sc:` searches **SoundCloud** instead of YouTube |
| `/play query: local: dark souls` | `local:` searches **your music folder** only |
| `/play file: (attach song.mp3)` | plays the uploaded file: mp3, flac, ogg, opus, wav, m4a, webm or mp4, up to 100 MB |

Spotify audio is DRM-protected, so no bot can stream it directly. This bot reads the song's name, artist and length from
Spotify, finds the same recording on YouTube (or SoundCloud), and plays that.

If the queue is empty the song plays right away. Otherwise it's **added to the end** and the bot tells you its position.

### Other ways to add music
| Command | What it does |
|---|---|
| `/playnext query:` or `file:` | same as `/play`, but puts the song **next** in the queue |
| `/search query: <words>` + optional `source: youtube / soundcloud` | shows the **5 best results** in a menu; pick one to queue it |
| `/local search query: <words>` | searches **your music folder** (by title, artist, album or file name; accents and typos are OK) and shows a menu |
| `/local all folder: <folder>` | queues a **whole folder** from the music library. Leave `folder` empty for everything; the field suggests subfolders as you type. |

**Local music:**
- On your PC, the music folder is `MUSIC_DIR`, by default `C:\Users\<you>\Music`.
- On Northflank it's the `music/` folder in the repository, or you can use `/play file:` uploads instead.

---

## 4. Controlling playback

| Command | Options / choices | What it does |
|---|---|---|
| `/pause` | – | pause |
| `/resume` | – | resume |
| `/skip` | `n` (optional, 1–1000) | skip the current song, or `n` songs |
| `/stop` | – | stop and **clear the queue** (the bot stays in the channel) |
| `/leave` | – | leave the voice channel |
| `/nowplaying` | – | show the *Now playing* card |
| `/seek` | `time` (required), e.g. `1:30`, `90`, `0:45` | jump to that point of the song |
| `/replay` | – | play the current song again from the start |
| `/volume` | `value` (optional, 0–200) | set the volume in %. With no value it shows the current one. It's saved per server; the default is 60. |
| `/loop` | `mode` (required): **off** · **track** · **queue** | *track* repeats the current song; *queue* repeats the whole queue |
| `/autoplay` | `state` (required): **on** · **off** | when the queue ends, keep playing related songs (default off) |

### The *Now playing* card
When a song starts, the bot posts a card with the title (a link), artist, a progress bar, the thumbnail, who requested
it, and the loop and volume status. It has five buttons:

| Button | Action |
|---|---|
| ⏯ | pause / resume |
| ⏭ | skip |
| ⏹ | stop and clear the queue |
| 🔁 | cycle the loop mode: off → track → queue |
| 🔀 | shuffle the queue |

The card updates itself every 30 seconds instead of posting new messages, so it doesn't spam the channel.

---

## 5. Managing the queue

| Command | Options | Example |
|---|---|---|
| `/queue` | `page` (optional, 1, 2, …) | `/queue` shows 10 songs per page; use the ◀ ▶ buttons to browse |
| `/remove` | `position` (required) | `/remove position: 3` removes song #3 |
| `/move` | `from`, `to` (both required) | `/move from: 5 to: 1` makes song #5 play next |
| `/shuffle` | – | shuffle the upcoming songs |
| `/clear` | – | remove all upcoming songs and keep the current one |

## 6. Saved playlists
Playlists belong to the server.

| Command | Example |
|---|---|
| `/playlist save name: <name>` | `/playlist save name: impreza` saves the current song plus the queue |
| `/playlist load name: <name>` | `/playlist load name: impreza` adds it to the queue; the name field suggests saved playlists |
| `/playlist list` | lists all saved playlists |
| `/playlist delete name: <name>` | deletes one |

On Northflank, saved playlists are **lost when the service is redeployed**, unless you attach a volume. See
DEPLOY_NORTHFLANK.md.

---

## 7. Who can do what
- With **no** `DJ_ROLE` set, everyone can do everything.
- With `DJ_ROLE` set (a role name or ID), these are reserved for that role and for admins:
  - skipping or removing songs **someone else** requested;
  - `/stop`, `/leave`, `/volume` and `/clear`.
- Everyone can always add songs, skip or remove their **own** songs, pause/resume, seek, and use `/move`, `/shuffle`, `/loop`
  and `/autoplay`.
- Saved playlists can be overwritten or deleted by whoever saved them, or by a DJ. With no `DJ_ROLE`, everyone counts as a DJ.
- You must be in the **same voice channel** as the bot to control it. Admins and DJs are exempt.
- To prevent spam, each person gets at most **5 requests per 10 seconds**, counted across `/play`, `/playnext`, `/search`, `/local` and `/playlist load` together.

## 8. Automatic behaviour (saves CPU)
- **Alone in the channel:** the bot pauses at once. It resumes if someone comes back within 3 minutes; otherwise it leaves.
- **Queue finished:** it leaves after 5 minutes of silence.
- **Paused:** after 1 minute it stops its background audio processes and remembers the position, so resuming works
  normally. It leaves after 10 minutes paused.
- **Busy:** at most 3 servers can play at the same time on the cloud plan. Anyone else gets a polite "busy" message.

## 9. Language
`LANG_BOT=pl` (the default) gives Polish messages, and `LANG_BOT=en` gives English. Command names are the same in both.

## 10. Common messages
| Message | Meaning |
|---|---|
| "Najpierw wejdź na kanał głosowy." / "Join a voice channel first." | you must be in a voice channel |
| "(z SoundCloud)" next to a title | YouTube blocked the server, so the same song was found on SoundCloud |
| "Nic nie znalazłem dla tego zapytania." | try different words, or paste a link |
| "Do tego potrzebujesz roli **DJ**." | that action is reserved for the DJ role (section 7) |
| "Zwolnij trochę: maks. 5 zapytań na 10 s…" | you hit the 5-per-10-seconds limit; wait a moment |
| "😴 Gram już na 3 serwerach/kanałach naraz…" | the cloud plan's limit on simultaneous players; try later |
| "Plik jest za duży…" | the uploaded file is over the size limit |
| age-restricted / sign-in errors | they need YouTube cookies (DEPLOY_NORTHFLANK.md, step 6) |
