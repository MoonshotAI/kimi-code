import { mkdir, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = fileURLToPath(new URL('./dist', import.meta.url));
await mkdir(dist, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (process.platform === 'darwin') {
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`;
  const nodeInclude = join(dirname(await realpath(process.execPath)), '..', 'include', 'node');
  run('xcrun', [
    'clang++', '-std=c++17', '-O2', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-target', target, '-DNAPI_VERSION=8', '-I', nodeInclude,
    '-framework', 'Foundation', '-framework', 'Network',
    'macos/probe.mm', '-o', 'dist/local-network.node',
  ]);
}
