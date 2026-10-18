// External tools: yt-dlp (downloaded into bin/ and self-updated once a day), deno (yt-dlp's JS runtime for
// YouTube's signature/n challenges, required since yt-dlp 2025.11), ffmpeg (PATH / FFMPEG_PATH / common dirs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const DENO_URL = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';
const DENO_MIN = [2, 3];
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
const STATE_FILE = path.join(config.dataDir, 'tools.json');

/** Resolved tool paths. `deno` may be null (then node itself is used as yt-dlp's JS runtime). */
export const tools = { ytdlp: null, deno: null, ffmpeg: null, ytdlpVersion: null };

const log = (...a) => console.log('[tools]', ...a);

/** Run a process to completion. Kills the whole tree on timeout/abort. */
export function run(cmd, args, { timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    const err = [];
    let timedOut = false;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const stop = () => killTree(child);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, timedOut, aborted: !!signal?.aborted, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/**
 * Kill a child and all its descendants. Needed on Windows: the one-file yt-dlp.exe (PyInstaller) runs the real
 * work in a child process that survives a plain TerminateProcess of the parent.
 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (WIN) {
    try {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch {} });
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
async function writeState(s) {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

async function download(url, dest) {
  log('downloading', url);
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'discord-music-bot' } });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fsp.rename(tmp, dest);
}

async function version(cmd, args = ['--version']) {
  try {
    const r = await run(cmd, args, { timeoutMs: 20_000 });
    return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
  } catch {
    return null;
  }
}

async function ensureYtdlp(state, { update }) {
  const p = config.ytdlpPath;
  const ours = path.resolve(path.dirname(p)) === path.resolve(config.binDir);
  if (!(await exists(p))) {
    if (!ours || !WIN) {
      // Custom path or non-Windows: fall back to PATH.
      const v = await version('yt-dlp');
      if (v) return { path: 'yt-dlp', version: v };
      throw new Error(`yt-dlp not found at ${p}`);
    }
    await download(YTDLP_URL, p);
    state.ytdlpUpdatedAt = Date.now();
  } else if (update && ours && Date.now() - (state.ytdlpUpdatedAt || 0) > UPDATE_EVERY_MS) {
    const r = await run(p, ['-U'], { timeoutMs: 90_000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }));
    log('yt-dlp -U:', (r.stdout + r.stderr).trim().split(/\r?\n/).pop());
    if (r.code === 0) state.ytdlpUpdatedAt = Date.now();
  }
  const v = await version(p);
  if (!v) throw new Error(`yt-dlp at ${p} does not run`);
  return { path: p, version: v };
}

function denoOk(v) {
  const m = /deno (\d+)\.(\d+)/.exec(v || '');
  return !!m && (+m[1] > DENO_MIN[0] || (+m[1] === DENO_MIN[0] && +m[2] >= DENO_MIN[1]));
}

async function ensureDeno() {
  const local = path.join(config.binDir, `deno${EXE}`);
  if (denoOk(await version(local))) return local;
  if (denoOk(await version('deno'))) return 'deno';
  if (!WIN) return null;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deno-dl-'));
  try {
    const zip = path.join(tmpDir, 'deno.zip');
    await download(DENO_URL, zip);
    // Windows 10+ ships bsdtar, which extracts zip files.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = await run(tar, ['-xf', zip, '-C', tmpDir], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`unzip deno: ${r.stderr}`);
    await fsp.mkdir(config.binDir, { recursive: true });
    await fsp.copyFile(path.join(tmpDir, 'deno.exe'), local);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  return denoOk(await version(local)) ? local : null;
}

async function findFfmpeg() {
  const cands = [config.ffmpegPath, 'ffmpeg'];
  if (WIN) {
    cands.push('C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(config.binDir, 'ffmpeg.exe'));
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
  }
  for (const c of [...new Set(cands.filter(Boolean))]) if (await version(c, ['-version'])) return c;
  return null;
}

let ensuring = null;
/**
 * Make sure yt-dlp, deno and ffmpeg are usable. Memoised; call once at startup.
 * Throws only if yt-dlp or ffmpeg is unusable; a deno failure falls back to node as yt-dlp's JS runtime.
 * @param {{update?: boolean}} [opts] update=false skips the daily `yt-dlp -U`
 */
export function ensureTools(opts = {}) {
  ensuring ??= (async () => {
    const state = await readState();
    const [y, deno, ffmpeg] = await Promise.all([
      ensureYtdlp(state, { update: opts.update ?? true }),
      ensureDeno().catch((e) => { log('deno unavailable, using node as JS runtime:', e.message); return null; }),
      findFfmpeg(),
    ]);
    await writeState(state).catch(() => {});
    if (!ffmpeg) throw new Error('ffmpeg not found (install: winget install Gyan.FFmpeg, or set FFMPEG_PATH)');
    Object.assign(tools, { ytdlp: y.path, ytdlpVersion: y.version, deno, ffmpeg });
    log(`yt-dlp ${y.version}, deno ${deno ?? '(none, using node)'}, ffmpeg ${ffmpeg}`);
    return tools;
  })();
  ensuring.catch(() => { ensuring = null; });
  return ensuring;
}

/** Common yt-dlp arguments: JS runtime for YouTube's challenges, cookies if configured. */
export function ytdlpBaseArgs() {
  const a = ['--no-warnings', '--no-progress', '--ignore-config'];
  a.push('--js-runtimes', tools.deno ? `deno:${tools.deno}` : `node:${process.execPath}`);
  if (config.ytdlpCookies && fs.existsSync(config.ytdlpCookies)) a.push('--cookies', config.ytdlpCookies);
  return a;
}
