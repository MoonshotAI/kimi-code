/**
 * Pure-function tests for the launchd backend. No real `launchctl` shell-out —
 * `execLaunchctl` is stubbed so we can assert the exact argv and force
 * pre-canned results.
 *
 * Mirrors openclaw's pattern from `../openclaw/src/daemon/launchd.test.ts`,
 * trimmed to the small ServiceManager surface.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildLaunchAgentPlist } from '../../src/svc/launchd-plist';
import {
  createLaunchdManager,
  resolveSupervisorProgram,
  parseLaunchctlPrint,
  type LaunchdManagerDeps,
} from '../../src/svc/launchd';
import { KIMI_SERVER_LABEL } from '../../src/svc/paths';
import { readInstallPlan, writeInstallPlan } from '../../src/svc/install-plan';
import type { ExecOptions, ExecResult } from '../../src/svc/exec';

interface StubCall {
  args: readonly string[];
  options?: ExecOptions;
}

function makeStubExec(responses: ReadonlyArray<ExecResult>) {
  const calls: StubCall[] = [];
  let i = 0;
  const execLaunchctl = async (args: readonly string[], options?: ExecOptions): Promise<ExecResult> => {
    calls.push({ args, options });
    const next = responses[i] ?? { stdout: '', stderr: '', code: 0 };
    i += 1;
    return next;
  };
  return { execLaunchctl, calls } as const;
}

function makeDeps(
  responses: ReadonlyArray<ExecResult>,
  workDir: string,
): { deps: LaunchdManagerDeps; calls: StubCall[]; plistPath: string; logPath: string; planPath: string } {
  const { execLaunchctl, calls } = makeStubExec(responses);
  const plistPath = join(workDir, 'Library', 'LaunchAgents', `${KIMI_SERVER_LABEL}.plist`);
  const logPath = join(workDir, 'server', 'server.log');
  const planPath = join(workDir, 'server', 'install.json');
  // Re-point the install-plan path side-effects by overriding via env.
  // Tests below pass `planPath` explicitly to read/writeInstallPlan, so the
  // deps only need to point launchctl + filesystem locations.
  const deps: LaunchdManagerDeps = {
    execLaunchctl,
    resolveProgram: () => '/usr/local/bin/kimi',
    plistPath: () => plistPath,
    logPath: () => logPath,
    guiDomain: () => 'gui/501',
  };
  return { deps, calls, plistPath, logPath, planPath };
}

let workDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kimi-launchd-test-'));
  // Pin KIMI_CODE_HOME so the implicit install.json path lands under workDir.
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

describe('buildLaunchAgentPlist', () => {
  it('renders a well-formed plist with label, ProgramArguments, and stdio paths', () => {
    const xml = buildLaunchAgentPlist({
      label: KIMI_SERVER_LABEL,
      programArguments: ['/usr/local/bin/kimi', 'server', 'run', '--port', '58627'],
      stdoutPath: '/tmp/x.log',
      stderrPath: '/tmp/x.log',
    });
    expect(xml).toContain(`<key>Label</key>\n    <string>${KIMI_SERVER_LABEL}</string>`);
    expect(xml).toContain('<string>/usr/local/bin/kimi</string>');
    expect(xml).toContain('<string>server</string>');
    expect(xml).toContain('<string>run</string>');
    expect(xml).not.toContain('<string>--host</string>');
    expect(xml).toContain('<string>--port</string>');
    expect(xml).toContain('<string>58627</string>');
    expect(xml).toContain('<key>StandardOutPath</key>\n    <string>/tmp/x.log</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(xml).toContain('<key>KeepAlive</key>\n    <true/>');
  });

  it('escapes XML-special characters in the program path', () => {
    const xml = buildLaunchAgentPlist({
      label: 'test',
      programArguments: ['/path/with & special <chars>'],
      stdoutPath: '/tmp/a',
      stderrPath: '/tmp/a',
    });
    expect(xml).toContain('/path/with &amp; special &lt;chars&gt;');
    expect(xml).not.toContain('& special <chars>');
  });
});

describe('parseLaunchctlPrint', () => {
  it('extracts state + pid from a `launchctl print` block', () => {
    const sample = [
      `${'gui/501/' + KIMI_SERVER_LABEL} = {`,
      '\tstate = running',
      '\tpid = 4711',
      '\tlast exit code = 78: EX_CONFIG',
      '\tprogram = /usr/local/bin/kimi',
      '}',
    ].join('\n');
    const parsed = parseLaunchctlPrint(sample);
    expect(parsed.state).toBe('running');
    expect(parsed.pid).toBe(4711);
    expect(parsed.lastExitCode).toBe('78: EX_CONFIG');
  });

  it('returns undefined fields when keys are missing', () => {
    const parsed = parseLaunchctlPrint('domain = gui/501\nactive count = 1');
    expect(parsed.state).toBeUndefined();
    expect(parsed.pid).toBeUndefined();
  });
});

describe('resolveSupervisorProgram', () => {
  it('normalizes a relative executable path to an absolute path', () => {
    expect(resolveSupervisorProgram(['node', './kimi'], '/tmp/kimi-bin')).toBe('/tmp/kimi-bin/kimi');
  });
});

describe('launchd manager — install', () => {
  it('writes the plist and bootstraps via launchctl', async () => {
    const { deps, calls, plistPath } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    const mgr = createLaunchdManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });

    expect(result.status).toBe('installed');
    expect(result.plistPath).toBe(plistPath);
    expect(existsSync(plistPath)).toBe(true);
    const xml = readFileSync(plistPath, 'utf8');
    expect(xml).toContain(`<string>${KIMI_SERVER_LABEL}</string>`);
    expect(xml).toContain('<string>/usr/local/bin/kimi</string>');
    expect(xml).toContain('<string>58627</string>');

    expect(calls.length).toBe(1);
    expect(calls[0]?.args).toEqual(['bootstrap', 'gui/501', plistPath]);
  });

  it('refuses to overwrite an existing install without --force', async () => {
    const { deps, calls, plistPath } = makeDeps([], workDir);
    require('node:fs').mkdirSync(plistPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(plistPath, '<stub/>');

    const mgr = createLaunchdManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });
    expect(result.status).toBe('already-installed');
    expect(calls.length).toBe(0); // never invoked launchctl
  });

  it('overwrites + replaces when force=true', async () => {
    const { deps, calls, plistPath } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // bootout
        { stdout: '', stderr: '', code: 0 }, // bootstrap
      ],
      workDir,
    );
    require('node:fs').mkdirSync(plistPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(plistPath, '<stub/>');

    const mgr = createLaunchdManager(deps);
    const result = await mgr.install({ host: '0.0.0.0', port: 9999, logLevel: 'debug', force: true });
    expect(result.status).toBe('replaced');
    expect(calls[0]?.args[0]).toBe('bootout');
    expect(calls[1]?.args[0]).toBe('bootstrap');
    const xml = readFileSync(plistPath, 'utf8');
    expect(xml).not.toContain('<string>0.0.0.0</string>');
    expect(xml).toContain('<string>9999</string>');
  });

  it('surfaces a launchctl bootstrap failure as a thrown error', async () => {
    const { deps } = makeDeps([{ stdout: '', stderr: 'GUI session unavailable', code: 5 }], workDir);
    const mgr = createLaunchdManager(deps);
    await expect(
      mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' }),
    ).rejects.toThrow(/launchctl bootstrap failed/);
  });

  it('treats `already loaded` bootstrap output as success', async () => {
    const { deps } = makeDeps(
      [{ stdout: '', stderr: 'service already loaded', code: 1 }],
      workDir,
    );
    const mgr = createLaunchdManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });
    expect(result.status).toBe('installed');
  });
});

describe('launchd manager — lifecycle', () => {
  it('start delegates to `launchctl kickstart -k <domain>/<label>`', async () => {
    const { deps, calls, plistPath } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    require('node:fs').mkdirSync(plistPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(plistPath, '<stub/>');
    const mgr = createLaunchdManager(deps);
    const result = await mgr.start();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['kickstart', '-k', `gui/501/${KIMI_SERVER_LABEL}`]);
  });

  it('start refuses when not installed', async () => {
    const { deps, calls } = makeDeps([], workDir);
    const mgr = createLaunchdManager(deps);
    const result = await mgr.start();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not installed/);
    expect(calls.length).toBe(0);
  });

  it('stop sends SIGTERM via `launchctl kill`', async () => {
    const { deps, calls } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    const mgr = createLaunchdManager(deps);
    const result = await mgr.stop();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['kill', 'SIGTERM', `gui/501/${KIMI_SERVER_LABEL}`]);
  });

  it('restart delegates to `launchctl kickstart -k`', async () => {
    const { deps, calls } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    const mgr = createLaunchdManager(deps);
    const result = await mgr.restart();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['kickstart', '-k', `gui/501/${KIMI_SERVER_LABEL}`]);
  });

  it('uninstall calls bootout, removes the plist, and clears the install plan', async () => {
    const { deps, calls, plistPath } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir);
    require('node:fs').mkdirSync(plistPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(plistPath, '<stub/>');
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

    const mgr = createLaunchdManager(deps);
    const result = await mgr.uninstall();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['bootout', `gui/501/${KIMI_SERVER_LABEL}`]);
    expect(existsSync(plistPath)).toBe(false);
    expect(readInstallPlan()).toBeUndefined();
  });
});

describe('launchd manager — status', () => {
  it('reports installed=false when no plist exists', async () => {
    const { deps } = makeDeps([], workDir);
    const mgr = createLaunchdManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.label).toBe(KIMI_SERVER_LABEL);
    expect(status.platform).toBe('darwin');
  });

  it('reports running=true + pid from `launchctl print`', async () => {
    const printOutput = `gui/501/${KIMI_SERVER_LABEL} = {\n\tstate = running\n\tpid = 9876\n}`;
    const { deps, plistPath } = makeDeps(
      [{ stdout: printOutput, stderr: '', code: 0 }],
      workDir,
    );
    require('node:fs').mkdirSync(plistPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(plistPath, '<stub/>');
    writeInstallPlan({
      host: '127.0.0.1',
      port: 58627,
      logLevel: 'info',
      program: '/usr/local/bin/kimi',
      programArguments: [],
      logPath: '/tmp/x',
      installedAt: '2026-06-11T00:00:00.000Z',
    });

    const mgr = createLaunchdManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(9876);
    expect(status.host).toBe('127.0.0.1');
    expect(status.port).toBe(58627);
  });

  it('reports installed=true, running=false when `launchctl print` fails', async () => {
    const { deps, plistPath } = makeDeps(
      [{ stdout: '', stderr: 'Could not find service', code: 113 }],
      workDir,
    );
    require('node:fs').mkdirSync(plistPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(plistPath, '<stub/>');
    const mgr = createLaunchdManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.notes?.[0]).toMatch(/launchctl print failed/);
  });
});
