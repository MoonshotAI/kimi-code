/**
 * `crossProcessLock` domain (L1) — node-local `ProcessProbe` implementation.
 *
 * `alive` follows `process.kill(pid, 0)` semantics: ESRCH means the pid is
 * gone; EPERM or any other failure is treated as conservatively alive so a
 * probing error never causes a live lock to be seized. `processStartedAt` is
 * the opaque pid-reuse identity token: darwin attempts `sysctl -n
 * kern.proc.starttime` (modern macOS exposes no named per-pid starttime OID
 * — the call fails and the token is absent, which the lock protocol treats
 * as "identity unavailable → treat as matching"); linux reads
 * `/proc/<pid>/stat` field 22 (starttime in clock ticks); other platforms
 * cannot provide one. The token is only ever compared for equality by
 * callers — it is never parsed for meaning, and `ps -o lstart=` is
 * deliberately not used (locale-dependent, unstable format). When the
 * process is dead the probe returns `{alive: false}` without collecting a
 * token; a token-collection failure on a live process degrades to
 * `{alive: true}` with no token.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { ProcessProbe } from '#/os/interface/crossProcessLock';

export function createNodeProcessProbe(): ProcessProbe {
  return (pid) => {
    if (!pidAlive(pid)) return { alive: false };
    return { alive: true, processStartedAt: readProcessStartedAt(pid) };
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function readProcessStartedAt(pid: number): string | undefined {
  try {
    if (process.platform === 'darwin') return darwinProcessStartedAt(pid);
    if (process.platform === 'linux') return linuxProcessStartedAt(pid);
    return undefined;
  } catch {
    return undefined;
  }
}

function darwinProcessStartedAt(pid: number): string | undefined {
  const out = execFileSync('sysctl', ['-n', 'kern.proc.starttime', String(pid)], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const match = /sec = (\d+), usec = (\d+)/.exec(out);
  if (match === null) return undefined;
  return `${match[1]}.${match[2]}`;
}

function linuxProcessStartedAt(pid: number): string | undefined {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = raw.lastIndexOf(')');
  if (close < 0) return undefined;
  const rest = raw.slice(close + 1).trim().split(' ');
  const starttime = rest[19];
  return starttime === undefined || starttime === '' ? undefined : starttime;
}
