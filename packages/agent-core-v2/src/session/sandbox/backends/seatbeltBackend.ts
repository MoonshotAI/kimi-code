/**
 * `sandbox` domain (L3) — seatbelt / `sandbox-exec` (macOS) sandbox backend.
 *
 * Probes availability by running `sandbox-exec -p '(version 1)(allow default)'
 * /usr/bin/true`, and wraps an argv as `sandbox-exec -p <profile> <argv…>`. The
 * generated SBPL profile is a conservative minimum modeled on codex / srt:
 * `(deny default)` plus process/IPC basics, `(allow file-read*)`, `deny
 * file-read*` masks for `denyRead` (in seatbelt an explicit deny always beats
 * allow), `allow file-write*` only under the writable roots, `deny file-write*`
 * overrides, and `(allow network*)` only when the network is enabled. Paths are
 * embedded as SBPL string literals with `\` and `"` escaped. Developed without
 * a macOS host — profile generation is fully covered by unit tests.
 */

import type { ResolvedSandboxPolicy } from '../sandboxTypes';

import type { ISandboxBackend, SpawnProbe } from './sandboxBackend';

export const SEATBELT_DETECT_ARGV: readonly string[] = [
  'sandbox-exec',
  '-p',
  '(version 1)(allow default)',
  '/usr/bin/true',
];

export class SeatbeltSandboxBackend implements ISandboxBackend {
  readonly id = 'seatbelt' as const;

  async detect(spawn: SpawnProbe): Promise<boolean> {
    try {
      return (await spawn([...SEATBELT_DETECT_ARGV])) === 0;
    } catch {
      return false;
    }
  }

  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): readonly string[] {
    return ['sandbox-exec', '-p', buildSeatbeltProfile(policy), ...argv];
  }
}

export function buildSeatbeltProfile(policy: ResolvedSandboxPolicy): string {
  const rules: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)',
  ];
  for (const p of policy.denyRead) {
    rules.push(`(deny file-read* (subpath "${escapeSbpl(p)}"))`);
  }
  for (const root of policy.writableRoots) {
    rules.push(`(allow file-write* (subpath "${escapeSbpl(root)}"))`);
  }
  for (const p of policy.denyWrite) {
    rules.push(`(deny file-write* (subpath "${escapeSbpl(p)}"))`);
  }
  if (policy.networkEnabled) rules.push('(allow network*)');
  return rules.join('\n');
}

function escapeSbpl(p: string): string {
  return p.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
