// External tools (Windows and Linux):
//  - yt-dlp: YTDLP_PATH, else BIN_DIR/yt-dlp[.exe] (downloaded from GitHub if missing), else PATH. Self-updated with
//    `-U` at most once a day when the binary is writable (YouTube breaks old versions quickly).
//  - deno: yt-dlp's JS runtime for YouTube's signature/n challenges (needed since yt-dlp 2025.11; EJS scripts are
//    bundled in the yt-dlp binaries). DENO_PATH, BIN_DIR/deno, PATH, else downloaded; node is the fallback runtime.
//  - ffmpeg/ffprobe: FFMPEG_PATH, PATH, common Windows dirs.
//  - cookies: YTDLP_COOKIES_B64 or YTDLP_COOKIES -> private 0600 temp copy (yt-dlp rewrites its cookie file).
// All yt-dlp flags live in ytdlpProfile / ytdlpBaseArgs() below.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const ARM = process.arch === 'arm64';
const GH = 'https://github.com';
const YTDLP_ASSET = WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : ARM ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
const DENO_ASSET = WIN ? 'deno-x86_64-pc-windows-msvc.zip'
  : process.platform === 'darwin' ? (ARM ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip')
  : ARM ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip';
const DENO_MIN = [2, 3];
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
const STATE_FILE = path.join(config.dataDir, 'tools.json');

const envList = (k) => {
  const v = (process.env[k] ?? '').trim();
  if (!v) return [];
  if (v.startsWith('[')) { try { return JSON.parse(v).map(String); } catch {} }
  return v.split(/\s+/);
};

/**
 * The one place for yt-dlp tuning (env-overridable, so cloud deploys can change flags without a rebuild):
 *  YTDLP_JS_RUNTIME     auto (deno if found, else node) | deno | node
 *  YTDLP_EXTRACTOR_ARGS e.g. "youtube:player_client=default,mweb"  (JSON array for several)
 *  YTDLP_EXTRA_ARGS     extra raw args, whitespace-separated or a JSON array
 */
export const ytdlpProfile = {
  jsRuntime: (process.env.YTDLP_JS_RUNTIME || 'auto').trim().toLowerCase(),
  extractorArgs: (() => {
    const v = (process.env.YTDLP_EXTRACTOR_ARGS ?? '').trim();
    if (!v) return [];
    if (v.startsWith('[')) { try { return JSON.parse(v).map(String); } catch {} }
    return [v];
  })(),
  extraArgs: envList('YTDLP_EXTRA_ARGS'),
};

/** Resolved tools. `deno` may be null (node is then yt-dlp's JS runtime); `ffprobe` and `cookies` are optional. */
export const tools = { ytdlp: null, ytdlpVersion: null, deno: null, ffmpeg: null, ffprobe: null, cookies: null };

const log = (...a) => console.log('[tools]', ...a);

/**
 * spawn() for tool processes. On Linux the child leads its own process group so killTree() can take down
 * everything it started (yt-dlp -> ffmpeg/deno helpers).
 */
export function spawnTool(cmd, args, opts = {}) {
  return spawn(cmd, args, { windowsHide: true, detached: !WIN, ...opts });
}

/** Kill a child and all its descendants (taskkill /T on Windows, the process group on Linux). Idempotent. */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (WIN) {
    // The one-file yt-dlp.exe (PyInstaller) runs its work in a child process that a plain kill would orphan.
    try {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch {} });
    } catch {
      try { child.kill(); } catch {}
    }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

/** Run a process to completion. Kills the whole tree on timeout/abort. */
export function run(cmd, args, { timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnTool(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
async function writable(p) {
  try { await fsp.access(p, fs.constants.W_OK); await fsp.access(path.dirname(p), fs.constants.W_OK); return true; } catch { return false; }
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
async function writeState(s) {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

async function download(url, dest, mode = 0o755) {
  log('downloading', url);
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'discord-music-bot' }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()), { mode });
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
  const envPath = (process.env.YTDLP_PATH ?? '').trim();
  const p = envPath || path.join(config.binDir, `yt-dlp${EXE}`);
  if (!envPath && !(await exists(p))) {
    try {
      await download(`${GH}/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`, p);
      state.ytdlpUpdatedAt = Date.now();
    } catch (e) {
      const v = await version('yt-dlp');
      if (v) { log(`download failed (${e.message}); using yt-dlp from PATH`); return { path: 'yt-dlp', version: v }; }
      throw e;
    }
  } else if (update && Date.now() - (state.ytdlpUpdatedAt || 0) > UPDATE_EVERY_MS) {
    if (await writable(p)) {
      const r = await run(p, ['-U'], { timeoutMs: 120_000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }));
      log('yt-dlp -U:', (r.stdout + r.stderr).trim().split(/\r?\n/).pop());
      if (r.code === 0) state.ytdlpUpdatedAt = Date.now();
    } else {
      log(`yt-dlp at ${p} is read-only; skipping self-update`);
    }
  }
  const v = await version(p);
  if (!v) throw new Error(`yt-dlp at ${p} does not run`);
  return { path: p, version: v };
}

function denoOk(v) {
  const m = /deno (\d+)\.(\d+)/.exec(v || '');
  return !!m && (+m[1] > DENO_MIN[0] || (+m[1] === DENO_MIN[0] && +m[2] >= DENO_MIN[1]));
}

async function unzip(zip, dir) {
  const tries = WIN
    ? [[path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]]]
    : [['unzip', ['-o', '-q', zip, '-d', dir]], ['bsdtar', ['-xf', zip, '-C', dir]], ['python3', ['-m', 'zipfile', '-e', zip, dir]]];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args, { timeoutMs: 120_000 }).catch(() => null);
    if (r?.code === 0) return;
  }
  throw new Error('no unzip tool (unzip/bsdtar/python3)');
}

async function ensureDeno() {
  const local = path.join(config.binDir, `deno${EXE}`);
  for (const c of [(process.env.DENO_PATH ?? '').trim(), local, 'deno'].filter(Boolean)) if (denoOk(await version(c))) return c;
  if (ytdlpProfile.jsRuntime === 'node') return null; // not wanted: don't download 100 MB
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deno-dl-'));
  try {
    const zip = path.join(tmpDir, 'deno.zip');
    await download(`${GH}/denoland/deno/releases/latest/download/${DENO_ASSET}`, zip, 0o644);
    await unzip(zip, tmpDir);
    await fsp.mkdir(config.binDir, { recursive: true });
    await fsp.copyFile(path.join(tmpDir, `deno${EXE}`), local);
    if (!WIN) await fsp.chmod(local, 0o755);
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
  } else {
    cands.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(config.binDir, 'ffmpeg'));
  }
  for (const c of [...new Set(cands.filter(Boolean))]) {
    if (!(await version(c, ['-version']))) continue;
    const base = path.basename(c);
    const probe = c === base ? c.replace(/ffmpeg/i, 'ffprobe') : path.join(path.dirname(c), base.replace(/ffmpeg/i, 'ffprobe'));
    return { ffmpeg: c, ffprobe: (await version(probe, ['-version'])) ? probe : null };
  }
  return null;
}

/** Write YTDLP_COOKIES_B64 / copy YTDLP_COOKIES into a private (0600) temp file. */
async function prepareCookies() {
  let data = null;
  if (config.ytdlpCookiesB64) data = Buffer.from(config.ytdlpCookiesB64, 'base64');
  else if (config.ytdlpCookies && (await exists(config.ytdlpCookies))) data = await fsp.readFile(config.ytdlpCookies);
  if (!data?.length) return null;
  const file = path.join(os.tmpdir(), `dmb-yt-cookies-${process.pid}.txt`);
  await fsp.writeFile(file, data, { mode: 0o600 });
  if (!WIN) await fsp.chmod(file, 0o600);
  process.once('exit', () => { try { fs.unlinkSync(file); } catch {} });
  return file;
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
    const [y, deno, ff, cookies] = await Promise.all([
      ensureYtdlp(state, { update: opts.update ?? true }),
      ensureDeno().catch((e) => { log('deno unavailable, using node as JS runtime:', e.message); return null; }),
      findFfmpeg(),
      prepareCookies().catch((e) => { log('cookies:', e.message); return null; }),
    ]);
    await writeState(state).catch(() => {});
    if (!ff) throw new Error(`ffmpeg not found (${WIN ? 'winget install Gyan.FFmpeg' : 'apt install ffmpeg'}, or set FFMPEG_PATH)`);
    Object.assign(tools, { ytdlp: y.path, ytdlpVersion: y.version, deno, ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe, cookies });
    log(`yt-dlp ${y.version}, js runtime ${jsRuntimeArg()}, ffmpeg ${ff.ffmpeg}${cookies ? ', cookies on' : ''}`);
    return tools;
  })();
  ensuring.catch(() => { ensuring = null; });
  return ensuring;
}

function jsRuntimeArg() {
  const want = ytdlpProfile.jsRuntime;
  if (want !== 'node' && tools.deno) return `deno:${tools.deno}`;
  return `node:${process.execPath}`;
}

/** Common yt-dlp arguments: JS runtime, extractor args, cookies and extra args from ytdlpProfile. */
export function ytdlpBaseArgs() {
  const a = ['--no-warnings', '--no-progress', '--ignore-config', '--js-runtimes', jsRuntimeArg()];
  for (const x of ytdlpProfile.extractorArgs) a.push('--extractor-args', x);
  if (tools.cookies) a.push('--cookies', tools.cookies);
  a.push(...ytdlpProfile.extraArgs);
  return a;
}
