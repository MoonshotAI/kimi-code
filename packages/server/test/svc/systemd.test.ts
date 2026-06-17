/**
 * Pure-function tests for the systemd backend. No real `systemctl` shell-out —
 * `execSystemctl` is stubbed so we can assert the exact argv.
 *
 * Mirrors the pattern from `launchd.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSystemdManager,
  type SystemdManagerDeps,
} from '../../src/svc/systemd';
import {
  buildSystemdUnit,
  parseSystemctlShow,
} from '../../src/svc/systemd-unit';
import { KIMI_SERVER_SYSTEMD_UNIT } from '../../src/svc/paths';
import { readInstallPlan, writeInstallPlan } from '../../src/svc/install-plan';
import { ServiceUnavailableError } from '../../src/svc/types';
import type { ExecOptions, ExecResult } from '../../src/svc/exec';

interface StubCall {
  args: readonly string[];
  options?: ExecOptions;
}

function makeStubExec(responses: ReadonlyArray<ExecResult>) {
  const calls: StubCall[] = [];
  let i = 0;
  const execSystemctl = async (
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push({ args, options });
    const next = responses[i] ?? { stdout: '', stderr: '', code: 0 };
    i += 1;
    return next;
  };
  return { execSystemctl, calls } as const;
}

function makeDeps(
  responses: ReadonlyArray<ExecResult>,
  workDir: string,
): { deps: SystemdManagerDeps; calls: StubCall[]; unitPath: string; logPath: string } {
  const { execSystemctl, calls } = makeStubExec(responses);
  const unitPath = join(workDir, 'systemd', 'user', KIMI_SERVER_SYSTEMD_UNIT);
  const logPath = join(workDir, 'server', 'server.log');
  const deps: SystemdManagerDeps = {
    execSystemctl,
    resolveProgram: () => '/usr/local/bin/kimi',
    unitPath: () => unitPath,
    logPath: () => logPath,
  };
  return { deps, calls, unitPath, logPath };
}

let workDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kimi-systemd-test-'));
  prevHome = process.env['KIMI_CODE_HOME'];
  process.env['KIMI_CODE_HOME'] = workDir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = prevHome;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('buildSystemdUnit', () => {
  it('renders the standard [Unit]/[Service]/[Install] triple', () => {
    const unit = buildSystemdUnit({
      programArguments: ['/usr/local/bin/kimi', 'server', 'run', '--port', '58627'],
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Description=Kimi Code local server');
    expect(unit).toContain('ExecStart=/usr/local/bin/kimi server run --port 58627');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('quotes argv elements with whitespace', () => {
    const unit = buildSystemdUnit({
      programArguments: ['/path with space/kimi', 'server', 'run'],
    });
    expect(unit).toContain('ExecStart="/path with space/kimi" server run');
  });

  it('rejects argv elements with CR/LF', () => {
    expect(() =>
      buildSystemdUnit({ programArguments: ['/usr/bin/kimi', 'server\nrun'] }),
    ).toThrow(/cannot contain CR or LF/);
  });

  it('renders Environment= lines', () => {
    const unit = buildSystemdUnit({
      programArguments: ['/usr/bin/kimi'],
      environment: { FOO: 'bar', BAZ: 'qux' },
    });
    expect(unit).toContain('Environment=FOO=bar');
    expect(unit).toContain('Environment=BAZ=qux');
  });
});

describe('parseSystemctlShow', () => {
  it('parses KEY=VALUE lines into a map', () => {
    const out = ['ActiveState=active', 'SubState=running', 'MainPID=4321', 'ExecStart={ path=/x }'].join('\n');
    const fields = parseSystemctlShow(out);
    expect(fields['ActiveState']).toBe('active');
    expect(fields['SubState']).toBe('running');
    expect(fields['MainPID']).toBe('4321');
    expect(fields['ExecStart']).toBe('{ path=/x }');
  });

  it('ignores lines without `=`', () => {
    const fields = parseSystemctlShow('hello world\nActiveState=active');
    expect(fields['ActiveState']).toBe('active');
    expect(Object.keys(fields).length).toBe(1);
  });
});

describe('systemd manager — install', () => {
  it('writes the unit, daemon-reloads, enables --now', async () => {
    const { deps, calls, unitPath } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // show-environment
        { stdout: '', stderr: '', code: 0 }, // daemon-reload
        { stdout: '', stderr: '', code: 0 }, // enable --now
      ],
      workDir,
    );
    const mgr = createSystemdManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });

    expect(result.status).toBe('installed');
    expect(result.unitPath).toBe(unitPath);
    expect(existsSync(unitPath)).toBe(true);
    const text = readFileSync(unitPath, 'utf8');
    expect(text).toContain('ExecStart=/usr/local/bin/kimi server run --port 58627 --log-level info');
    expect(text).not.toContain('--host');

    expect(calls.length).toBe(3);
    expect(calls[0]?.args).toEqual(['show-environment']);
    expect(calls[1]?.args).toEqual(['daemon-reload']);
    expect(calls[2]?.args).toEqual(['enable', '--now', KIMI_SERVER_SYSTEMD_UNIT]);
  });

  it('refuses to overwrite an existing install without --force', async () => {
    const { deps, calls, unitPath } = makeDeps([], workDir);
    mkdirSync(unitPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(unitPath, '# stub');

    const mgr = createSystemdManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });
    expect(result.status).toBe('already-installed');
    expect(calls.length).toBe(0);
  });

  it('overwrites + replaces when force=true', async () => {
    const { deps, unitPath } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // show-environment
        { stdout: '', stderr: '', code: 0 }, // daemon-reload
        { stdout: '', stderr: '', code: 0 }, // enable --now
      ],
      workDir,
    );
    mkdirSync(unitPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(unitPath, '# old');

    const mgr = createSystemdManager(deps);
    const result = await mgr.install({ host: '0.0.0.0', port: 9999, logLevel: 'debug', force: true });
    expect(result.status).toBe('replaced');
    const text = readFileSync(unitPath, 'utf8');
    expect(text).toContain('ExecStart=/usr/local/bin/kimi server run --port 9999 --log-level debug');
    expect(text).not.toContain('0.0.0.0');
  });

  it('fails before writing files when user systemd is unavailable', async () => {
    const { deps, calls, unitPath } = makeDeps(
      [
        {
          stdout: '',
          stderr: 'System has not been booted with systemd as init system (PID 1).',
          code: 1,
        },
      ],
      workDir,
    );
    const mgr = createSystemdManager(deps);

    await expect(
      mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    expect(calls).toEqual([{ args: ['show-environment'], options: undefined }]);
    expect(existsSync(unitPath)).toBe(false);
    expect(readInstallPlan()).toBeUndefined();
  });

  it('surfaces daemon-reload failure as a thrown error', async () => {
    const { deps } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 },
        { stdout: '', stderr: 'unit not loaded', code: 1 },
      ],
      workDir,
    );
    const mgr = createSystemdManager(deps);
    await expect(
      mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' }),
    ).rejects.toThrow(/daemon-reload failed/);
  });

  it('surfaces enable --now failure as a thrown error', async () => {
    const { deps } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 },
        { stdout: '', stderr: '', code: 0 },
        { stdout: '', stderr: 'unit failed to start', code: 1 },
      ],
      workDir,
    );
    const mgr = createSystemdManager(deps);
    await expect(
      mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' }),
    ).rejects.toThrow(/enable --now failed/);
  });
});

describe('systemd manager — lifecycle', () => {
  it('start delegates to `systemctl --user start`', async () => {
    const { deps, calls, unitPath } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    mkdirSync(unitPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(unitPath, '# stub');
    const mgr = createSystemdManager(deps);
    const result = await mgr.start();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['start', KIMI_SERVER_SYSTEMD_UNIT]);
  });

  it('start refuses when not installed', async () => {
    const { deps, calls } = makeDeps([], workDir);
    const mgr = createSystemdManager(deps);
    const result = await mgr.start();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not installed/);
    expect(calls.length).toBe(0);
  });

  it('stop delegates to `systemctl --user stop`', async () => {
    const { deps, calls } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    const mgr = createSystemdManager(deps);
    const result = await mgr.stop();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['stop', KIMI_SERVER_SYSTEMD_UNIT]);
  });

  it('restart delegates to `systemctl --user restart`', async () => {
    const { deps, calls } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    const mgr = createSystemdManager(deps);
    const result = await mgr.restart();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['restart', KIMI_SERVER_SYSTEMD_UNIT]);
  });

  it('uninstall calls disable + removes unit + clears plan', async () => {
    const { deps, calls, unitPath } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // disable --now
        { stdout: '', stderr: '', code: 0 }, // daemon-reload
      ],
      workDir,
    );
    mkdirSync(unitPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(unitPath, '# stub');
    writeInstallPlan({
      host: '127.0.0.1',
      port: 58627,
      logLevel: 'info',
      program: '/usr/local/bin/kimi',
      programArguments: ['/usr/local/bin/kimi', 'server', 'run'],
      logPath: '/tmp/x',
      installedAt: '2026-06-11T00:00:00.000Z',
    });
    expect(readInstallPlan()).toBeDefined();

    const mgr = createSystemdManager(deps);
    const result = await mgr.uninstall();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['disable', '--now', KIMI_SERVER_SYSTEMD_UNIT]);
    expect(calls[1]?.args).toEqual(['daemon-reload']);
    expect(existsSync(unitPath)).toBe(false);
    expect(readInstallPlan()).toBeUndefined();
  });
});

describe('systemd manager — status', () => {
  it('reports installed=false when no unit exists', async () => {
    const { deps } = makeDeps([], workDir);
    const mgr = createSystemdManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.platform).toBe('linux');
    expect(status.unitName).toBe(KIMI_SERVER_SYSTEMD_UNIT);
  });

  it('reports running=true + pid from `systemctl --user show`', async () => {
    const showOutput = ['ActiveState=active', 'SubState=running', 'MainPID=9876'].join('\n');
    const { deps, unitPath } = makeDeps([{ stdout: showOutput, stderr: '', code: 0 }], workDir);
    mkdirSync(unitPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(unitPath, '# stub');
    writeInstallPlan({
      host: '127.0.0.1',
      port: 58627,
      logLevel: 'info',
      program: '/usr/local/bin/kimi',
      programArguments: [],
      logPath: '/tmp/x',
      installedAt: '2026-06-11T00:00:00.000Z',
    });

    const mgr = createSystemdManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(9876);
    expect(status.host).toBe('127.0.0.1');
    expect(status.port).toBe(58627);
  });

  it('reports installed=true, running=false when `systemctl show` fails', async () => {
    const { deps, unitPath } = makeDeps(
      [{ stdout: '', stderr: 'Failed to connect', code: 1 }],
      workDir,
    );
    mkdirSync(unitPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(unitPath, '# stub');
    const mgr = createSystemdManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.notes?.[0]).toMatch(/systemctl --user show failed/);
  });
});
