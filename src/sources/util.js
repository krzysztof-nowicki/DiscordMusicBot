// Small shared helpers for the source modules: text normalisation, similarity, LRU/TTL cache, fetch with timeout.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Letters that NFD does not decompose.
const FOLD = { ł: 'l', Ł: 'l', ø: 'o', Ø: 'o', ß: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', đ: 'd', Đ: 'd', þ: 'th', ı: 'i' };

/** Lowercase, strip accents (incl. ł/ø/ß), turn punctuation into spaces, collapse whitespace. */
export function norm(s) {
  return String(s ?? '')
    .replace(/[łŁøØßæÆœŒđĐþı]/g, (c) => FOLD[c])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const tokens = (s) => norm(s).split(' ').filter(Boolean);

/** Levenshtein distance with an early exit when it exceeds `max`. */
export function lev(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Share of `want` tokens found in `have` (0..1), tolerant to small typos in longer words. */
export function tokenCoverage(want, have) {
  const w = Array.isArray(want) ? want : tokens(want);
  const h = Array.isArray(have) ? have : tokens(have);
  if (!w.length) return 0;
  let hit = 0;
  for (const t of w) {
    if (h.includes(t)) hit += 1;
    else if (t.length >= 4 && h.some((x) => x.startsWith(t) || lev(t, x, 1) <= 1)) hit += 0.8;
  }
  return hit / w.length;
}

/** "3:23" / "1:02:03" -> seconds; null if unparsable. */
export function parseClock(s) {
  if (!s) return null;
  const p = String(s).trim().split(':').map(Number);
  if (!p.length || p.some((n) => !Number.isFinite(n))) return null;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

/** Map-based LRU with optional TTL. */
export class Lru {
  constructor(max = 200, ttlMs = 0) { this.max = max; this.ttl = ttlMs; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) { this.m.delete(k); return undefined; }
    this.m.delete(k); this.m.set(k, e);
    return e.v;
  }
  set(k, v, ttlMs = this.ttl) {
    this.m.delete(k);
    this.m.set(k, { v, exp: ttlMs ? Date.now() + ttlMs : 0 });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return v;
  }
  delete(k) { this.m.delete(k); }
}

/** fetch() with a timeout (and an optional outer AbortSignal). */
export async function fetchT(url, { timeoutMs = 8000, signal, ...init } = {}) {
  const sigs = [AbortSignal.timeout(timeoutMs)];
  if (signal) sigs.push(signal);
  return fetch(url, { ...init, signal: AbortSignal.any(sigs) });
}

/** JSON file helpers (atomic write). */
export async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
export async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}
