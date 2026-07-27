#!/usr/bin/env node
// Fall back to node-pty's shipped prebuild when a local rebuild is unavailable.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const prebuild = `${desktopDir}/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/pty.node`;

const result = spawnSync('electron-rebuild', {
  cwd: desktopDir,
  stdio: 'inherit',
  // Windows command shims require a shell.
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
