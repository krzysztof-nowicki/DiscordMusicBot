// Scoring YouTube candidates against a wanted song (Spotify metadata or a plain text query). Pure (tested offline).
import { norm, tokenCoverage, tokens } from './util.js';

export const DURATION_TOLERANCE_SEC = 7;

// Words that mark a different version; penalised unless the wanted title contains them too.
const VARIANTS = ['live', 'cover', 'remix', 'karaoke', 'instrumental', 'sped up', 'speed up', 'slowed', 'reverb', 'nightcore', '8d',
  'reaction', 'tutorial', 'lesson', 'extended', '1 hour', '10 hours', 'hour loop', 'loop', 'mashup', 'bass boosted', 'acoustic', 'demo', 'teaser', 'trailer', 'shorts'];

function hasPhrase(normText, phrase) {
  return ` ${normText} `.includes(` ${phrase} `);
}

/**
 * Score one candidate. Higher is better; < MIN_SCORE means "not this song".
 * @param {{title: string, channel?: string, durationSec?: number|null, isLive?: boolean, verifiedArtist?: boolean}} cand
 * @param {{title: string, artist?: string, durationSec?: number|null}} want
 */
export function scoreCandidate(cand, want) {
  const cTitle = norm(cand.title);
  const cChan = norm(cand.channel || '');
  const wTitle = norm(want.title);
  const wArtist = norm(want.artist || '');
  const artistTokens = tokens(want.artist || '');
  const hay = tokens(`${cand.title} ${cand.channel || ''}`);
  let s = 0;

  // Title similarity: wanted title tokens present in candidate title (bracketed parts like "(feat. X)" weigh less).
  const coreTitle = want.title.replace(/[([].*?[)\]]/g, ' ').replace(/\s+-\s+.*$/, '');
  const titleCov = tokenCoverage(tokens(coreTitle).length ? coreTitle : want.title, artistTokens.length ? tokens(cand.title) : hay);
  s += 50 * titleCov;
  // Extra candidate words beyond artist + title (noise) cost a little.
  const wantAll = new Set([...tokens(want.title), ...artistTokens]);
  const extra = tokens(cand.title).filter((t) => !wantAll.has(t) && !['official', 'audio', 'video', 'music', 'lyrics', 'lyric', 'hd', 'hq', '4k', 'remastered', 'remaster', 'ft', 'feat', 'mv', 'topic', 'visualizer'].includes(t));
  s -= Math.min(15, extra.length * 2);

  if (artistTokens.length) {
    const artCov = tokenCoverage(artistTokens, hay);
    s += 20 * artCov;
    if (wArtist && (cChan === wArtist || cChan === `${wArtist} topic` || cChan.replace(/vevo$/, '').trim() === wArtist.replace(/\s/g, ''))) s += 10;
  }

  if (/ - Topic$/.test(cand.channel || '')) s += 25;
  if (hasPhrase(cTitle, 'official audio')) s += 15;
  else if (hasPhrase(cTitle, 'official music video') || hasPhrase(cTitle, 'official video')) s += 6;
  if (/vevo$/i.test(cand.channel || '') || cand.verifiedArtist) s += 6;
  if (hasPhrase(cTitle, 'lyrics') || hasPhrase(cTitle, 'lyric video')) s -= 2;

  for (const v of VARIANTS) if (hasPhrase(cTitle, v) && !hasPhrase(wTitle, v)) s -= 30;
  if (cand.isLive && want.durationSec) s -= 40;

  if (want.durationSec && cand.durationSec) {
    const d = Math.abs(want.durationSec - cand.durationSec);
    if (d <= DURATION_TOLERANCE_SEC) s += 30 - (d / DURATION_TOLERANCE_SEC) * 10; // +30..+20 inside the tolerance
    else if (d <= 15) s += 20 - ((d - DURATION_TOLERANCE_SEC) / 8) * 30; // +20..-10 just outside (intros/outros)
    else s -= Math.min(40, 10 + (d - 15) * 2); // -10..-40: a different version
  }
  return Math.round(s * 10) / 10;
}

export const MIN_SCORE = 35;

/** Rank candidates; returns [{cand, score}] sorted best-first. */
export function rankCandidates(cands, want) {
  return cands.map((cand) => ({ cand, score: scoreCandidate(cand, want) })).sort((a, b) => b.score - a.score);
}
