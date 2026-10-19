// Run the source tests (offline + live) inside the built Docker image: npm run test:docker
//   node test/run-in-docker.mjs [--build] [--image discord-music-bot:test] [--cpus 0.2] [--memory 512m] [--offline-only]
// The image excludes test/ (.dockerignore), so it is mounted read-only at /app/test.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const image = opt('image', 'discord-music-bot:test');

function docker(args) {
  console.log(`> docker ${args.join(' ')}`);
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (argv.includes('--build') && docker(['build', '-t', image, root]) !== 0) process.exit(1);

const limits = [];
if (opt('cpus')) limits.push(`--cpus=${opt('cpus')}`);
if (opt('memory')) limits.push(`--memory=${opt('memory')}`);
const files = argv.includes('--offline-only') ? ['test/sources.test.js'] : ['test/sources.test.js', 'test/live/sources.live.test.js'];
process.exit(docker(['run', '--rm', ...limits, '-v', `${path.join(root, 'test')}:/app/test:ro`, '-w', '/app', '--entrypoint', 'node',
  image, '--test', '--test-concurrency=1', ...files]));
