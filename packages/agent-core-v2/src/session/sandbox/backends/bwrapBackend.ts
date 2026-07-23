/**
 * `sandbox` domain (L3) — bubblewrap (Linux) sandbox backend.
 *
 * Probes availability by running `bwrap --ro-bind / / -- true` (exit 0 also
 * proves user namespaces work, e.g. the Ubuntu 24.04 apparmor restriction
 * surfaces as a non-zero probe), and wraps an argv as
 * `bwrap --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp …`
 * with one `--bind` per writable root, `--tmpfs` (dir) / `--ro-bind /dev/null`
 * (file) masks for `denyRead`, `--ro-bind` overrides for `denyWrite`, and
 * `--unshare-net` when the network is disabled. Bind order matters: all masks
 * come after the writable binds so they override them. `denyRead` masks apply
 * anywhere (the root bind is readable), while `denyWrite` outside the writable
 * roots is already read-only and skipped. Path classification is injectable
 * (`PathKindProbe`) for tests; the default uses `node:fs`.
 */

import type { ResolvedSandboxPolicy } from '../sandboxTypes';

import {
  defaultPathKind,
  type ISandboxBackend,
  type PathKindProbe,
  type SpawnProbe,
} from './sandboxBackend';

export const BWRAP_DETECT_ARGV: readonly string[] = ['bwrap', '--ro-bind', '/', '/', '--', 'true'];

export class BwrapSandboxBackend implements ISandboxBackend {
  readonly id = 'bwrap' as const;

  constructor(private readonly pathKind: PathKindProbe = defaultPathKind) {}

  async detect(spawn: SpawnProbe): Promise<boolean> {
    try {
      return (await spawn([...BWRAP_DETECT_ARGV])) === 0;
    } catch {
      return false;
    }
  }

  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): readonly string[] {
    const args: string[] = [
      'bwrap',
      '--die-with-parent',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
    ];

    const writableRoots = policy.writableRoots.filter((root) => this.pathKind(root) !== 'missing');
    for (const root of writableRoots) {
      args.push('--bind', root, root);
    }

    for (const p of policy.denyRead) {
      const kind = this.pathKind(p);
      if (kind === 'dir') args.push('--tmpfs', p);
      else if (kind === 'file') args.push('--ro-bind', '/dev/null', p);
    }

    for (const p of policy.denyWrite) {
      if (!writableRoots.some((root) => isWithinPath(p, root))) continue;
      if (this.pathKind(p) === 'missing') continue;
      args.push('--ro-bind', p, p);
    }

    if (!policy.networkEnabled) args.push('--unshare-net');

    args.push('--', ...argv);
    return args;
  }
}

function isWithinPath(p: string, root: string): boolean {
  if (root === '/') return true;
  return p === root || p.startsWith(`${root}/`);
}
