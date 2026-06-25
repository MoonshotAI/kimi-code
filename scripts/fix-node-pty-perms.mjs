#!/usr/bin/env node
/**
 * Restore the executable bit on node-pty's `spawn-helper` prebuilt binaries.
 *
 * Why: on macOS/Linux node-pty launches the shell through a tiny `spawn-helper`
 * executable shipped under `prebuilds/<platform-arch>/`. pnpm's content-
 * addressable store does not preserve the +x mode on these non-bin prebuild
 * assets, so after `pnpm install` the helper lands as 0644 and any PTY spawn
 * fails with "posix_spawnp failed". npm/yarn (and the published tarball) keep
 * the bit, so this is a pnpm-dev-only fixup.
 *
 * Idempotent and never fails the install: any error is logged and ignored.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function nodePtyRoot() {
  const require = createRequire(import.meta.url);
  // Resolve from packages/services (where node-pty is declared) so we find the
  // workspace's hoisted copy regardless of where this script runs.
  const entry = require.resolve('node-pty', {
    paths: [join(process.cwd(), 'packages/services'), process.cwd()],
  });
  // .../node-pty/lib/index.js -> .../node-pty
  return dirname(dirname(entry));
}

try {
  const root = nodePtyRoot();
  const prebuilds = join(root, 'prebuilds');
  if (!existsSync(prebuilds)) process.exit(0);
  let fixed = 0;
  for (const arch of readdirSync(prebuilds)) {
    const helper = join(prebuilds, arch, 'spawn-helper');
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0o111) continue; // already executable
    chmodSync(helper, 0o755);
    fixed++;
  }
  if (fixed > 0) console.log(`[fix-node-pty-perms] made ${fixed} spawn-helper binary(ies) executable`);
} catch (err) {
  console.warn('[fix-node-pty-perms] skipped:', err instanceof Error ? err.message : String(err));
}
process.exit(0);
