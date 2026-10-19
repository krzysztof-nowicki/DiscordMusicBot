// Shared Track type, a constructor helper and the SourceError used by every source module.
import { config } from '../config.js';

/** @typedef {'youtube'|'spotify'|'soundcloud'|'bandcamp'|'local'|'http'|'radio'|'attachment'|'generic'} SourceName */

/** @typedef {Object} Track
 * @property {string} id            stable key, e.g. "yt:dQw4w9WgXcQ", "sp:4uLU6hMCjMI75M1A2tKUQC", "local:<relpath>"
 * @property {string} title
 * @property {string} [artist]
 * @property {number|null} durationSec   null = live / unknown
 * @property {string} [url]          canonical page URL (shown as a link)
 * @property {string} [thumbnail]
 * @property {SourceName} source
 * @property {boolean} isLive
 * @property {string} [requestedBy]  Discord user id (set by the player)
 * @property {string} [streamUrl]    internal: what createStream() feeds to yt-dlp/ffmpeg when it differs from `url`
 *                                   (local absolute path, radio/http URL, generic page URL). Player: pass through untouched.
 * @property {'soundcloud'} [fallback] set by createStream() when YouTube refused (bot check) and a SoundCloud match
 *                                   is playing instead; the UI shows "(z SoundCloud)". `fallbackTrack` is that match.
 * @property {'youtube'} [fallbackFrom] set together with `fallback`.
 * @property {Track} [fallbackTrack]
 */

/**
 * Build a Track with defaults and normalised fields.
 * @param {Partial<Track> & {id: string, title: string, source: SourceName}} t
 * @returns {Track}
 */
export function makeTrack(t) {
  const d = Number(t.durationSec);
  const track = {
    id: String(t.id),
    title: String(t.title || '').trim() || 'Unknown',
    artist: t.artist ? String(t.artist).trim() : undefined,
    durationSec: t.isLive ? null : Number.isFinite(d) && d > 0 ? Math.round(d) : null,
    url: t.url || undefined,
    thumbnail: t.thumbnail || undefined,
    source: t.source,
    isLive: !!t.isLive,
  };
  if (t.requestedBy) track.requestedBy = t.requestedBy;
  if (t.streamUrl) track.streamUrl = t.streamUrl;
  for (const k of Object.keys(track)) if (track[k] === undefined) delete track[k];
  return track;
}

const MESSAGES = {
  NOT_FOUND: { pl: 'Nic nie znalazłem dla tego zapytania.', en: 'Nothing found for that query.' },
  UNSUPPORTED: { pl: 'Tego linku nie umiem odtworzyć.', en: "I can't play that link." },
  UNAVAILABLE: { pl: 'Ten utwór jest niedostępny (usunięty, prywatny lub zablokowany w regionie).', en: 'This track is unavailable (removed, private or region-blocked).' },
  AGE_RESTRICTED: { pl: 'Ten film ma ograniczenie wiekowe (potrzebne cookies: YTDLP_COOKIES).', en: 'This video is age-restricted (cookies needed: YTDLP_COOKIES).' },
  NO_MATCH: { pl: 'Nie udało się znaleźć tego utworu ze Spotify na YouTube.', en: "Couldn't find this Spotify track on YouTube." },
  BOT_CHECK: { pl: 'YouTube blokuje ten serwer ("potwierdź, że nie jesteś botem"). Potrzebne cookies (YTDLP_COOKIES_B64).', en: "YouTube is blocking this server (\"confirm you're not a bot\"). Cookies needed (YTDLP_COOKIES_B64)." },
  NETWORK: { pl: 'Problem z połączeniem ze źródłem. Spróbuj ponownie za chwilę.', en: 'Network problem reaching the source. Try again shortly.' },
  TOOL_MISSING: { pl: 'Brakuje narzędzia (yt-dlp lub ffmpeg). Uruchom setup.ps1.', en: 'A tool is missing (yt-dlp or ffmpeg). Run setup.ps1.' },
  LOCAL_MISSING: { pl: 'Nie znaleziono pliku w lokalnej bibliotece.', en: 'File not found in the local library.' },
  STREAM_FAILED: { pl: 'Nie udało się odtworzyć tego utworu.', en: "Couldn't play this track." },
};

/** Error with a short user-facing message (in config.lang) and the technical cause in `.detail`. */
export class SourceError extends Error {
  /**
   * @param {keyof typeof MESSAGES} code
   * @param {string} [detail] technical detail for logs
   * @param {{cause?: unknown}} [opts]
   */
  constructor(code, detail = '', opts = {}) {
    const m = MESSAGES[code] || MESSAGES.STREAM_FAILED;
    super(m[config.lang] || m.pl, opts);
    this.name = 'SourceError';
    this.code = code;
    this.detail = detail;
    /** Same as message: safe to show in Discord. */
    this.userMessage = this.message;
  }
}
