#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.KIMI_SKIP_DESKTOP_PTY_REBUILD === '1') {
  console.log('[rebuild-native] Skipping Electron node-pty rebuild for the standalone CLI');
  process.exit(0);
}

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const prebuild = `${desktopDir}/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/pty.node`;

const result = spawnSync('electron-rebuild', ['--only', 'node-pty'], {
  cwd: desktopDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status === 0) {
  process.exit(0);
}

if (existsSync(prebuild)) {
  console.warn(
    `[rebuild-native] electron-rebuild failed (no build toolchain?), but node-pty ships a ` +
      `${process.platform}-${process.arch} prebuild — continuing with it.`,
  );
  process.exit(0);
}

process.exit(result.status ?? 1);
