

import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SandboxBackend } from '../backend';
import type { ResolvedSandboxProfile, SandboxSpawnPlan } from '../types';

const BWRAP_PATH = 'bwrap';

export class BwrapBackend implements SandboxBackend {
  readonly name = 'bwrap' as const;
  readonly supported = true;

  wrap(
    command: string,
    args: readonly string[],
    profile: ResolvedSandboxProfile,
  ): SandboxSpawnPlan {
    const argv: string[] = [
      '--new-session',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--tmpfs',
      '/tmp',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
    ];

    for (const root of profile.writableRoots) {
      argv.push('--bind-try', normalizePath(root), normalizePath(root));
    }
    for (const path of profile.denyWritePaths) {
      const normalized = normalizePath(path);
      argv.push('--ro-bind-try', normalized, normalized);
    }
    for (const path of profile.denyReadPaths) {
      const normalized = normalizePath(path);
      if (isDirectory(normalized)) {
        argv.push('--tmpfs', normalized);
      } else {
        argv.push('--ro-bind-try', '/dev/null', normalized);
      }
    }

    argv.push('--unshare-user', '--unshare-pid', '--unshare-ipc');
    const advisoryProxy =
      profile.network.mode === 'allowlist' && profile.network.proxyPorts !== undefined;
    if (profile.network.mode !== 'all' && !advisoryProxy) {
      argv.push('--unshare-net');
    }
    argv.push('--cap-drop', 'ALL');
    argv.push('--chdir', normalizePath(profile.cwd));
    argv.push('--');
    argv.push(command, ...args);

    return { command: BWRAP_PATH, args: argv, env: {} };
  }
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
