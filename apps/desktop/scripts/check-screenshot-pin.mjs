import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'tsdown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(tmpdir(), 'screenshot-pin-check-'));
await build({
  config: false,
  entry: {
    'screenshot-output': join(root, 'src/main/screenshot/screenshot-output.ts'),
    protocol: join(root, 'src/main/app/protocol.ts'),
    shotPinPreload: join(root, 'src/main/screenshot/screenshot-pin-preload.ts'),
  },
  format: ['cjs'], platform: 'node', outDir: output, dts: false,
  deps: { neverBundle: ['electron'], onlyBundle: false },
});
const electron = createRequire(import.meta.url)('electron');
const result = spawnSync(electron, [join(root, 'tests/main/fixtures/screenshot-pin-window.cjs'), output, root, ...process.argv.slice(2)], {
  stdio: 'inherit', timeout: 60_000, windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
