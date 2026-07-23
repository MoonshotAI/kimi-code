/**
 * sandboxPolicy tests for the v2 sandbox domain.
 *
 * Exercises the pure `resolveSandboxPolicy`: writable-root sets per mode,
 * `~` expansion against the host home directory, normalization and dedupe,
 * the always-on `DEFAULT_DENY_READ` list, and the literal `.env` masks under
 * every writable root.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DENY_READ,
  DEFAULT_DENY_READ_SOCKETS,
  resolveSandboxPolicy,
  resolveXdgRuntimeDir,
} from '#/session/sandbox/sandboxPolicy';
import type { SandboxConfig } from '#/session/sandbox/sandboxTypes';

const ENV = { tmpdir: '/tmp', homeDir: '/home/test' } as const;
const WORKSPACE = { workDir: '/workspace/app', additionalDirs: ['/workspace/extra'] } as const;

const EXPANDED_DEFAULTS = DEFAULT_DENY_READ.map((p) => `/home/test/${p.slice(2)}`);

function expectedDenyRead(writableRoots: readonly string[], userRules: readonly string[] = []) {
  return [
    ...EXPANDED_DEFAULTS,
    ...DEFAULT_DENY_READ_SOCKETS,
    ...writableRoots.map((root) => `${root}/.env`),
    ...userRules,
  ];
}

describe('resolveSandboxPolicy', () => {
  it('defaults to workspace-write with workspace + additionalDirs + tmpdir writable', () => {
    const policy = resolveSandboxPolicy({}, WORKSPACE, ENV);

    expect(policy.mode).toBe('workspace-write');
    expect(policy.writableRoots).toEqual(['/workspace/app', '/workspace/extra', '/tmp']);
    expect(policy.denyWrite).toEqual([]);
    expect(policy.networkEnabled).toBe(false);
  });

  it('always includes the built-in deny_read list and a literal .env under each writable root', () => {
    const policy = resolveSandboxPolicy({}, WORKSPACE, ENV);

    expect(policy.denyRead).toEqual(
      expectedDenyRead(['/workspace/app', '/workspace/extra', '/tmp']),
    );
  });

  it('read-only mode keeps only tmpdir + filesystem.allowWrite writable', () => {
    const config: SandboxConfig = {
      mode: 'read-only',
      filesystem: { allowWrite: ['/data/out'] },
    };
    const policy = resolveSandboxPolicy(config, WORKSPACE, ENV);

    expect(policy.mode).toBe('read-only');
    expect(policy.writableRoots).toEqual(['/tmp', '/data/out']);
    expect(policy.denyRead).toEqual(expectedDenyRead(['/tmp', '/data/out']));
  });

  it('appends filesystem.allowWrite in workspace-write mode', () => {
    const config: SandboxConfig = { filesystem: { allowWrite: ['/data/out', '~/.cache/tool'] } };
    const policy = resolveSandboxPolicy(config, WORKSPACE, ENV);

    expect(policy.writableRoots).toEqual([
      '/workspace/app',
      '/workspace/extra',
      '/tmp',
      '/data/out',
      '/home/test/.cache/tool',
    ]);
  });

  it('expands ~ in denyRead / denyWrite / allowWrite against homeDir', () => {
    const config: SandboxConfig = {
      filesystem: {
        denyRead: ['~/.gnupg', '~/secrets.txt', '/etc/shadow'],
        denyWrite: ['~/.git', '~'],
        allowWrite: ['~'],
      },
    };
    const policy = resolveSandboxPolicy(config, WORKSPACE, ENV);

    // ~/.gnupg is already in the built-in defaults — merged without duplicates.
    expect(policy.denyRead).toEqual(
      expectedDenyRead(['/workspace/app', '/workspace/extra', '/tmp', '/home/test'], [
        '/home/test/secrets.txt',
        '/etc/shadow',
      ]),
    );
    expect(policy.denyWrite).toEqual(['/home/test/.git', '/home/test']);
    expect(policy.writableRoots).toContain('/home/test');
  });

  it('strips a trailing /** from rule entries', () => {
    const config: SandboxConfig = { filesystem: { denyRead: ['/data/secret/**'] } };
    const policy = resolveSandboxPolicy(config, WORKSPACE, ENV);

    expect(policy.denyRead).toContain('/data/secret');
    expect(policy.denyRead).not.toContain('/data/secret/**');
  });

  it('normalizes and dedupes roots', () => {
    const config: SandboxConfig = {
      filesystem: { allowWrite: ['/workspace/app/', '/data//out'] },
    };
    const policy = resolveSandboxPolicy(
      config,
      { workDir: '/workspace/app', additionalDirs: ['/workspace/app', '/workspace/extra'] },
      ENV,
    );

    expect(policy.writableRoots).toEqual(['/workspace/app', '/workspace/extra', '/tmp', '/data/out']);
    expect(policy.denyRead.filter((p) => p === '/workspace/app/.env')).toHaveLength(1);
  });

  it('masks host daemon sockets and (optionally) $XDG_RUNTIME_DIR sockets by default', () => {
    const withoutXdg = resolveSandboxPolicy({}, WORKSPACE, ENV);
    for (const socket of DEFAULT_DENY_READ_SOCKETS) {
      expect(withoutXdg.denyRead).toContain(socket);
    }
    expect(withoutXdg.denyRead.some((p) => p.startsWith('/run/user/'))).toBe(false);

    const withXdg = resolveSandboxPolicy({}, WORKSPACE, {
      ...ENV,
      xdgRuntimeDir: '/run/user/1000',
    });
    expect(withXdg.denyRead).toEqual(
      expect.arrayContaining([
        '/run/user/1000/bus',
        '/run/user/1000/docker.sock',
        '/run/user/1000/podman/podman.sock',
        '/run/user/1000/gnupg',
      ]),
    );
  });

  it('re-protects workspace roots under tmpdir in read-only mode', () => {
    const policy = resolveSandboxPolicy(
      { mode: 'read-only' },
      { workDir: '/tmp/repo', additionalDirs: ['/tmp/lib', '/workspace/outside'] },
      ENV,
    );

    expect(policy.writableRoots).toEqual(['/tmp']);
    expect(policy.denyWrite).toEqual(['/tmp/repo', '/tmp/lib']);
  });

  it('keeps denyWrite free of workspace roots outside tmpdir in read-only mode', () => {
    const policy = resolveSandboxPolicy({ mode: 'read-only' }, WORKSPACE, ENV);

    expect(policy.denyWrite).toEqual([]);
  });

  it('reads networkEnabled from network.enabled', () => {
    expect(resolveSandboxPolicy({ network: { enabled: true } }, WORKSPACE, ENV).networkEnabled).toBe(
      true,
    );
    expect(resolveSandboxPolicy({ network: {} }, WORKSPACE, ENV).networkEnabled).toBe(false);
  });
});

describe('resolveXdgRuntimeDir', () => {
  it('prefers $XDG_RUNTIME_DIR, falls back to /run/user/<uid>, then undefined', () => {
    expect(resolveXdgRuntimeDir({ XDG_RUNTIME_DIR: '/run/user/42' }, 1000)).toBe('/run/user/42');
    expect(resolveXdgRuntimeDir({ XDG_RUNTIME_DIR: '' }, 1000)).toBe('/run/user/1000');
    expect(resolveXdgRuntimeDir({}, 1000)).toBe('/run/user/1000');
    expect(resolveXdgRuntimeDir({}, undefined)).toBeUndefined();
  });
});
