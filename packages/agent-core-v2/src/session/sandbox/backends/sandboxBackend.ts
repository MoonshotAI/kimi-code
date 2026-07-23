/**
 * `sandbox` domain (L3) — OS sandbox backend contract.
 *
 * A sandbox backend knows how to probe its own availability (`detect`, given a
 * spawn primitive) and how to wrap a fully-formed argv with its sandbox
 * (`wrap`), applying a `ResolvedSandboxPolicy`. Implementations: bubblewrap
 * (Linux) and seatbelt / `sandbox-exec` (macOS). Windows has no backend — the
 * service reports `unsupported-platform`. `SpawnProbe` runs an argv and
 * resolves with the exit code; `PathKind` classifies a path so `wrap` can pick
 * the right bind strategy (injectable for tests; `defaultPathKind` stats the
 * host filesystem, classifying anything non-directory — files, sockets,
 * devices — as `file` so they get the `/dev/null` mask).
 */

import { statSync } from 'node:fs';

import type { ResolvedSandboxPolicy, SandboxBackendId } from '../sandboxTypes';

export type SpawnProbe = (argv: string[]) => Promise<number>;

export type PathKind = 'file' | 'dir' | 'missing';

export type PathKindProbe = (path: string) => PathKind;

export interface ISandboxBackend {
  readonly id: SandboxBackendId;
  detect(spawn: SpawnProbe): Promise<boolean>;
  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): readonly string[];
}

export function defaultPathKind(p: string): PathKind {
  try {
    return statSync(p).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}
