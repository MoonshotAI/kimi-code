/**
 * SandboxService tests for the v2 sandbox domain.
 *
 * Drives `decide` through every branch — disabled, excluded command, sandboxed
 * (Linux bwrap / macOS seatbelt), fail-closed blocked, fail-open unsandboxed,
 * unsupported platform — with stubbed `IConfigService`,
 * `ISessionWorkspaceContext`, `IHostEnvironment`, `IHostProcessService` (the
 * backend probe), and `ILogService`. Also covers the probe caching and the
 * `matchExcludedCommand` segment/prefix matcher.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ILogService } from '#/_base/log/log';
import type { IConfigService } from '#/app/config/config';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { BwrapSandboxBackend } from '#/session/sandbox/backends/bwrapBackend';
import type { ISandboxBackend } from '#/session/sandbox/backends/sandboxBackend';
import { SeatbeltSandboxBackend } from '#/session/sandbox/backends/seatbeltBackend';
import { matchExcludedCommand, SandboxService } from '#/session/sandbox/sandboxService';
import type { SandboxConfig } from '#/session/sandbox/sandboxTypes';
import { stubWorkspaceContext } from '../workspaceContext/stub-workspace-context';

// Backends with a stubbed path classifier so wrap never touches the real fs.
function testBackend(osKind: string): ISandboxBackend | undefined {
  if (osKind === 'Linux') return new BwrapSandboxBackend(() => 'dir');
  if (osKind === 'macOS') return new SeatbeltSandboxBackend();
  return undefined;
}

function stubConfig(section: SandboxConfig | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (domain: string) => (domain === 'sandbox' ? section : undefined),
  } as unknown as IConfigService;
}

function stubEnv(osKind: string): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind,
    osArch: 'arm64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home/test',
    ready: Promise.resolve(),
  };
}

function stubHostProcess(exitCode: number): {
  readonly hostProcess: IHostProcessService;
  readonly spawn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn(async (): Promise<IHostProcess> => {
    return {
      _serviceBrand: undefined,
      pid: 1,
      exitCode,
      stdin: {} as IHostProcess['stdin'],
      stdout: {} as IHostProcess['stdout'],
      stderr: {} as IHostProcess['stderr'],
      wait: async () => exitCode,
      kill: async () => {},
      dispose: () => {},
    };
  });
  return {
    hostProcess: { _serviceBrand: undefined, spawn } as unknown as IHostProcessService,
    spawn,
  };
}

function stubLog(): { readonly log: ILogService; readonly warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { log: { _serviceBrand: undefined, warn } as unknown as ILogService, warn };
}

function service(options: {
  readonly config?: SandboxConfig;
  readonly osKind?: string;
  readonly probeExitCode?: number;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
}): {
  readonly sandbox: SandboxService;
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
} {
  const { hostProcess, spawn } = stubHostProcess(options.probeExitCode ?? 0);
  const { log, warn } = stubLog();
  const sandbox = new SandboxService(
    stubConfig(options.config),
    stubWorkspaceContext(options.workDir ?? '/workspace/app', options.additionalDirs ?? []),
    stubEnv(options.osKind ?? 'Linux'),
    hostProcess,
    log,
    testBackend,
  );
  return { sandbox, spawn, warn };
}

describe('SandboxService.decide', () => {
  it('runs unsandboxed when the section is missing or enabled is not true', async () => {
    const { sandbox } = service({ config: undefined });
    await expect(sandbox.decide('ls', '/workspace/app')).resolves.toEqual({
      kind: 'unsandboxed',
      reason: 'disabled',
    });

    const off = service({ config: { enabled: false } });
    await expect(off.sandbox.decide('ls', '/workspace/app')).resolves.toEqual({
      kind: 'unsandboxed',
      reason: 'disabled',
    });
  });

  it('reports excluded commands without probing the backend', async () => {
    const { sandbox, spawn } = service({
      config: { enabled: true, excludedCommands: ['docker'] },
    });

    await expect(sandbox.decide('docker ps', '/workspace/app')).resolves.toEqual({
      kind: 'excluded',
      matched: 'docker',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('wraps the shell argv with bwrap on Linux when the probe succeeds', async () => {
    const { sandbox, spawn } = service({
      config: { enabled: true, filesystem: { denyRead: ['/home/test/.ssh'] } },
      additionalDirs: ['/workspace/extra'],
    });

    const decision = await sandbox.decide('echo ok', '/workspace/app');
    expect(decision.kind).toBe('sandboxed');
    if (decision.kind !== 'sandboxed') return;
    expect(decision.backendId).toBe('bwrap');
    expect(decision.argv[0]).toBe('bwrap');
    expect(decision.argv).toContain('--unshare-net');
    expect(decision.argv).toEqual(
      expect.arrayContaining(['--bind', '/workspace/app', '/workspace/app']),
    );
    expect(decision.argv).toEqual(
      expect.arrayContaining(['--bind', '/workspace/extra', '/workspace/extra']),
    );
    const separator = decision.argv.indexOf('--');
    expect(decision.argv.slice(separator + 1)).toEqual([
      '/bin/bash',
      '-c',
      "cd '/workspace/app' && echo ok",
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe('bwrap');
  });

  it('does not promote an outside-workspace cwd into the writable roots', async () => {
    const { sandbox } = service({ config: { enabled: true } });

    const decision = await sandbox.decide('pwd', '/home/test/other-project');
    expect(decision.kind).toBe('sandboxed');
    if (decision.kind !== 'sandboxed') return;
    // The shell still cds into the requested cwd, but it stays read-only.
    expect(decision.argv).not.toEqual(
      expect.arrayContaining(['--bind', '/home/test/other-project', '/home/test/other-project']),
    );
    expect(decision.argv).toEqual(
      expect.arrayContaining(['--bind', '/workspace/app', '/workspace/app']),
    );
    expect(decision.argv.slice(decision.argv.indexOf('--') + 1)).toEqual([
      '/bin/bash',
      '-c',
      "cd '/home/test/other-project' && pwd",
    ]);
  });

  it('wraps with seatbelt on macOS', async () => {
    const { sandbox } = service({ config: { enabled: true }, osKind: 'macOS' });

    const decision = await sandbox.decide('echo ok', '/workspace/app');
    expect(decision.kind).toBe('sandboxed');
    if (decision.kind !== 'sandboxed') return;
    expect(decision.backendId).toBe('seatbelt');
    expect(decision.argv[0]).toBe('sandbox-exec');
  });

  it('caches the backend probe across decisions', async () => {
    const { sandbox, spawn } = service({ config: { enabled: true } });

    await sandbox.decide('one', '/workspace/app');
    await sandbox.decide('two', '/workspace/app');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('fails closed when require is true and the backend is unavailable', async () => {
    const { sandbox } = service({ config: { enabled: true, require: true }, probeExitCode: 1 });

    const decision = await sandbox.decide('ls', '/workspace/app');
    expect(decision.kind).toBe('blocked');
    if (decision.kind !== 'blocked') return;
    expect(decision.reason).toContain('require');
    expect(decision.reason).toContain('bwrap');
  });

  it('fails open with a one-time warning when require is not set', async () => {
    const { sandbox, warn } = service({ config: { enabled: true }, probeExitCode: 1 });

    await expect(sandbox.decide('ls', '/workspace/app')).resolves.toEqual({
      kind: 'unsandboxed',
      reason: 'backend-unavailable',
    });
    await sandbox.decide('ls', '/workspace/app');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported-platform on Windows, blocked only when required', async () => {
    const open = service({ config: { enabled: true }, osKind: 'Windows' });
    await expect(open.sandbox.decide('ls', 'C:\\repo')).resolves.toEqual({
      kind: 'unsandboxed',
      reason: 'unsupported-platform',
    });

    const closed = service({ config: { enabled: true, require: true }, osKind: 'Windows' });
    const decision = await closed.sandbox.decide('ls', 'C:\\repo');
    expect(decision.kind).toBe('blocked');
    if (decision.kind !== 'blocked') return;
    expect(decision.reason).toContain('Windows');
  });

  it('treats a failing probe spawn as backend-unavailable', async () => {
    const { sandbox } = service({ config: { enabled: true }, probeExitCode: 1 });
    await expect(sandbox.decide('ls', '/workspace/app')).resolves.toEqual({
      kind: 'unsandboxed',
      reason: 'backend-unavailable',
    });
  });
});

describe('matchExcludedCommand', () => {
  it('matches the first token of a segment', () => {
    expect(matchExcludedCommand('docker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('podman ps', ['docker'])).toBeUndefined();
  });

  it('splits on &&, ||, ;, | and newlines', () => {
    expect(matchExcludedCommand('ls && docker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('ls || docker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('ls; docker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('ls | docker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('ls\ndocker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('ls && echo hi', ['docker'])).toBeUndefined();
  });

  it('strips leading env assignments before matching', () => {
    expect(matchExcludedCommand('FOO=bar BAZ=1 docker ps', ['docker'])).toBe('docker');
    expect(matchExcludedCommand('FOO=bar echo ok', ['docker'])).toBeUndefined();
  });

  it('matches multi-word entries as a prefix with a word boundary', () => {
    expect(matchExcludedCommand('git push origin main', ['git push'])).toBe('git push');
    expect(matchExcludedCommand('git push', ['git push'])).toBe('git push');
    expect(matchExcludedCommand('git pushforce', ['git push'])).toBeUndefined();
    expect(matchExcludedCommand('git pul', ['git push'])).toBeUndefined();
  });

  it('requires a word boundary for single-word entries', () => {
    expect(matchExcludedCommand('docker-compose up', ['docker'])).toBeUndefined();
  });

  it('returns undefined for an empty exclusion list', () => {
    expect(matchExcludedCommand('docker ps', [])).toBeUndefined();
  });
});
