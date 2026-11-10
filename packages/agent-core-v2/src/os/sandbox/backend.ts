

import { accessSync, constants } from 'node:fs';

import type {
  ResolvedSandboxProfile,
  SandboxBackendName,
  SandboxSpawnPlan,
} from './types';

export interface SandboxBackend {
  readonly name: SandboxBackendName;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  wrap(
    command: string,
    args: readonly string[],
    profile: ResolvedSandboxProfile,
  ): SandboxSpawnPlan;
}

const DENIAL_QUICK_REJECT_EXIT_CODES: ReadonlySet<number> = new Set([2, 126, 127]);

const SIGSYS_EXIT_CODE = 128 + 31;

const DENIAL_KEYWORDS: readonly string[] = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'seccomp',
  'sandbox:',
  'landlock',
  'bwrap:',
  'failed to write file',
];

export function isLikelySandboxDenial(
  exitCode: number | null,
  outputTail: string,
): boolean {
  if (exitCode === null || exitCode === 0) return false;
  if (exitCode === SIGSYS_EXIT_CODE) return true;
  if (DENIAL_QUICK_REJECT_EXIT_CODES.has(exitCode)) return false;
  const lower = outputTail.toLowerCase();
  return DENIAL_KEYWORDS.some((needle) => lower.includes(needle));
}

export function detectSandboxBackend(): {
  readonly name: SandboxBackendName;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
} {
  if (process.platform === 'darwin') {
    try {
      accessSync('/usr/bin/sandbox-exec', constants.X_OK);
      return { name: 'seatbelt', supported: true };
    } catch {
      return {
        name: 'seatbelt',
        supported: false,
        unsupportedReason: '/usr/bin/sandbox-exec is missing or not executable',
      };
    }
  }
  if (process.platform === 'linux') {
    return findExecutableOnPath('bwrap') !== undefined
      ? { name: 'bwrap', supported: true }
      : {
          name: 'bwrap',
          supported: false,
          unsupportedReason:
            'bubblewrap (bwrap) not found on PATH; install bubblewrap to enable the sandbox',
        };
  }
  return {
    name: 'unsupported',
    supported: false,
    unsupportedReason: `sandbox is not supported on ${process.platform}; only macOS (seatbelt) and Linux (bwrap) are implemented`,
  };
}

export function findExecutableOnPath(name: string): string | undefined {
  const pathEnv = process.env['PATH'];
  if (pathEnv === undefined) return undefined;
  for (const dir of pathEnv.split(':')) {
    if (dir.length === 0) continue;
    const candidate = `${dir}/${name}`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return undefined;
}
