/**
 * BwrapSandboxBackend integration tests for the v2 sandbox domain.
 *
 * Runs the real `bwrap` binary against wrapped argv produced by
 * `BwrapSandboxBackend.wrap` in temporary directories under the host tmpdir,
 * verifying the end-to-end filesystem and network semantics: workspace writes
 * succeed, `$HOME` writes fail, `denyRead` masks files with `/dev/null`,
 * `denyWrite` re-binds subtrees read-only, and `--unshare-net` kills the
 * network. Skipped entirely when `bwrap` (or `curl` for the network case) is
 * not on PATH.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BwrapSandboxBackend } from '#/session/sandbox/backends/bwrapBackend';
import type { ResolvedSandboxPolicy } from '#/session/sandbox/sandboxTypes';

function onPath(binary: string): boolean {
  return spawnSync('which', [binary], { stdio: 'ignore' }).status === 0;
}

const hasBwrap = onPath('bwrap');
const hasCurl = onPath('curl');

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(argv: readonly string[]): RunResult {
  const result = spawnSync(argv[0]!, [...argv.slice(1)], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function policy(overrides: Partial<ResolvedSandboxPolicy> = {}): ResolvedSandboxPolicy {
  return {
    mode: 'workspace-write',
    // Mirrors `resolveSandboxPolicy`: tmpdir is always a writable root, so the
    // host /tmp is bind-mounted back over the scratch `--tmpfs /tmp`.
    writableRoots: [tmpdir()],
    denyRead: [],
    denyWrite: [],
    networkEnabled: false,
    ...overrides,
  };
}

describe.skipIf(!hasBwrap)('BwrapSandboxBackend integration', () => {
  let tempDirs: string[] = [];
  let homeProbes: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const probe of homeProbes.splice(0)) rmSync(probe, { force: true });
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-sandbox-it-'));
    tempDirs.push(dir);
    return dir;
  }

  function makeHomeProbe(): string {
    const probe = join(
      process.env['HOME'] ?? tmpdir(),
      `.kimi-sandbox-it-${String(process.pid)}-${String(homeProbes.length)}`,
    );
    homeProbes.push(probe);
    return probe;
  }

  function sh(script: string, p: ResolvedSandboxPolicy): RunResult {
    const argv = new BwrapSandboxBackend().wrap(['/bin/sh', '-c', script], p);
    return run(argv);
  }

  it('detect() reports the backend as available', async () => {
    const probe = async (argv: string[]): Promise<number> => run(argv).status;
    await expect(new BwrapSandboxBackend().detect(probe)).resolves.toBe(true);
  });

  it('allows writes inside the writable root but denies writes to $HOME', () => {
    const ws = makeTempDir();
    const homeProbe = makeHomeProbe();
    const result = sh(`touch '${ws}/ok.txt' && echo ws-ok; touch '${homeProbe}'`, policy({
      writableRoots: [ws, tmpdir()],
    }));

    expect(result.stdout).toContain('ws-ok');
    expect(existsSync(join(ws, 'ok.txt'))).toBe(true);
    expect(existsSync(homeProbe)).toBe(false);
  });

  it('masks a denyRead file with /dev/null (contents unreadable)', () => {
    const ws = makeTempDir();
    const secretDir = makeTempDir();
    const secretFile = join(secretDir, 'fake_id_rsa');
    writeFileSync(secretFile, 'SECRET-KEY-MATERIAL');

    const control = sh(`cat '${secretFile}'`, policy({ writableRoots: [ws, tmpdir()] }));
    expect(control.stdout).toBe('SECRET-KEY-MATERIAL');

    // Depending on the bind flags the mask surfaces as an empty read or as
    // "Permission denied" — either way the contents must not leak.
    const masked = sh(`cat '${secretFile}' 2>&1; echo rc=$?`, policy({
      writableRoots: [ws, tmpdir()],
      denyRead: [secretFile],
    }));
    expect(masked.stdout).not.toContain('SECRET-KEY-MATERIAL');
    expect(masked.stdout).toMatch(/Permission denied|rc=0/);
  });

  it('masks a denyRead directory with a tmpfs (contents disappear)', () => {
    const ws = makeTempDir();
    const secretDir = makeTempDir();
    writeFileSync(join(secretDir, 'key'), 'SECRET');

    const masked = sh(`ls '${secretDir}'`, policy({
      writableRoots: [ws, tmpdir()],
      denyRead: [secretDir],
    }));
    expect(masked.status).toBe(0);
    expect(masked.stdout.trim()).toBe('');
  });

  it('re-binds a denyWrite subtree read-only inside a writable root', () => {
    const ws = makeTempDir();
    const locked = join(ws, 'locked');
    mkdirSync(locked);

    const result = sh(
      `touch '${ws}/ok.txt' && echo ws-ok; touch '${locked}/nope.txt' && echo locked-write-ok`,
      policy({ writableRoots: [ws, tmpdir()], denyWrite: [locked] }),
    );

    expect(result.stdout).toContain('ws-ok');
    expect(result.stdout).not.toContain('locked-write-ok');
    expect(existsSync(join(ws, 'ok.txt'))).toBe(true);
    expect(existsSync(join(locked, 'nope.txt'))).toBe(false);
  });

  it.skipIf(!hasCurl)('blocks the network when networkEnabled is false', () => {
    const ws = makeTempDir();
    const result = sh(
      'curl -sS --max-time 3 https://example.com -o /dev/null',
      policy({ writableRoots: [ws, tmpdir()], networkEnabled: false }),
    );

    expect(result.status).not.toBe(0);
  });
});
