import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  for (const arch of ['arm64', 'x86_64']) {
    run('xcrun', [
      'clang', '-O2', '-Wall', '-mmacosx-version-min=12.0', '-arch', arch,
      'main.c', '-framework', 'IOKit', '-framework', 'CoreFoundation',
      '-o', `dist/clamshell-tool-${arch}`,
    ]);
  }
  run('lipo', [
    '-create', '-output', 'dist/clamshell-tool',
    'dist/clamshell-tool-arm64', 'dist/clamshell-tool-x86_64',
  ]);
  await rm(`${dist}/clamshell-tool-arm64`);
  await rm(`${dist}/clamshell-tool-x86_64`);
}
