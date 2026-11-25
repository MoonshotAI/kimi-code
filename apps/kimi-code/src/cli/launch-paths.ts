import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolve } from 'pathe';

import type { CLIOptions } from './options';

export function resolveLaunchPaths(
  opts: Pick<CLIOptions, 'agentFiles' | 'skillsDirs'>,
  launchDir: string,
): { readonly agentFiles: string[]; readonly skillDirs: string[] } {
  const checkoutRoot = findCheckoutRoot(launchDir) ?? launchDir;
  return {
    agentFiles: opts.agentFiles.map((file) => resolveFrom(launchDir, file)),
    skillDirs: opts.skillsDirs.map((dir) => resolveFrom(checkoutRoot, dir)),
  };
}

function resolveFrom(base: string, path: string): string {
  return path === '~' || path.startsWith('~/') ? path : resolve(base, path);
}

function findCheckoutRoot(dir: string): string | undefined {
  if (existsSync(join(dir, '.git'))) return dir;
  const parent = dirname(dir);
  return parent === dir ? undefined : findCheckoutRoot(parent);
}
