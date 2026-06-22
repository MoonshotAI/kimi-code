/**
 * Pure-function tests for the schtasks backend. No real `schtasks` shell-out —
 * `execSchtasks` and the temp-XML writer are stubbed so we can assert the
 * exact argv and pre-canned `/Query` output.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSchtasksManager,
  type SchtasksManagerDeps,
} from '../../src/svc/schtasks';
import { buildScheduledTaskXml, parseSchtasksQuery } from '../../src/svc/schtasks-xml';
import { KIMI_SERVER_TASK_NAME } from '../../src/svc/paths';
import { readInstallPlan, writeInstallPlan } from '../../src/svc/install-plan';
import type { ExecOptions, ExecResult } from '../../src/svc/exec';

interface StubCall {
  args: readonly string[];
  options?: ExecOptions;
}

function makeStubExec(responses: ReadonlyArray<ExecResult>) {
  const calls: StubCall[] = [];
  let i = 0;
  const execSchtasks = async (
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push({ args, options });
    const next = responses[i] ?? { stdout: '', stderr: '', code: 0 };
    i += 1;
    return next;
  };
  return { execSchtasks, calls } as const;
}

function makeDeps(
  responses: ReadonlyArray<ExecResult>,
  workDir: string,
  taskExistsValue: boolean = false,
): { deps: SchtasksManagerDeps; calls: StubCall[]; writtenXmls: string[] } {
  const { execSchtasks, calls } = makeStubExec(responses);
  const writtenXmls: string[] = [];
  const deps: SchtasksManagerDeps = {
    execSchtasks,
    resolveProgram: () => 'C\\:Program Files\\Kimi\\kimi.exe',
    logPath: () => join(workDir, 'server', 'server.log'),
    writeTaskXml: (xml) => {
      const path = join(workDir, `task-${writtenXmls.length}.xml`);
      // Skip actual fs write — tests only need a unique path.
      writtenXmls.push(xml);
      return path;
    },
    taskExists: async () => taskExistsValue,
  };
  return { deps, calls, writtenXmls };
}

let workDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kimi-schtasks-test-'));
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

describe('buildScheduledTaskXml', () => {
  it('renders a well-formed task XML with command and arguments', () => {
    const xml = buildScheduledTaskXml({
      description: 'test desc',
      command: 'C:\\bin\\kimi.exe',
      arguments: 'server run --port 58627',
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain('<Description>test desc</Description>');
    expect(xml).toContain('<Command>C:\\bin\\kimi.exe</Command>');
    expect(xml).toContain('<Arguments>server run --port 58627</Arguments>');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('escapes XML-special characters in the description', () => {
    const xml = buildScheduledTaskXml({
      description: 'has & < > characters',
      command: 'C:\\kimi.exe',
    });
    expect(xml).toContain('<Description>has &amp; &lt; &gt; characters</Description>');
  });

  it('omits <Arguments> when no args provided', () => {
    const xml = buildScheduledTaskXml({
      description: 'desc',
      command: 'C:\\kimi.exe',
    });
    expect(xml).not.toContain('<Arguments>');
  });

  it('injects UserId when taskUser is set', () => {
    const xml = buildScheduledTaskXml({
      description: 'desc',
      command: 'C:\\kimi.exe',
      taskUser: 'DOMAIN\\alice',
    });
    expect(xml).toContain('<UserId>DOMAIN\\alice</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).not.toContain('<GroupId>S-1-5-32-545</GroupId>');
  });
});

describe('parseSchtasksQuery', () => {
  it('parses CSV header + first row into a record', () => {
    const csv = [
      '"HostName","TaskName","Status","Last Result","Run As User"',
      '"WORKSTATION","\\KimiServer","Running","0","alice"',
    ].join('\r\n');
    const row = parseSchtasksQuery(csv);
    expect(row).toBeDefined();
    expect(row?.['Status']).toBe('Running');
    expect(row?.['TaskName']).toBe('\\KimiServer');
    expect(row?.['Run As User']).toBe('alice');
  });

  it('handles escaped quotes inside CSV cells', () => {
    const csv = [
      '"TaskName","Description"',
      '"\\KimiServer","with ""quotes"" inside"',
    ].join('\n');
    const row = parseSchtasksQuery(csv);
    expect(row?.['Description']).toBe('with "quotes" inside');
  });

  it('returns undefined when output has no data row', () => {
    expect(parseSchtasksQuery('')).toBeUndefined();
    expect(parseSchtasksQuery('"HostName","TaskName"')).toBeUndefined();
  });
});

describe('schtasks manager — install', () => {
  it('writes the XML, runs schtasks /Create, then /Run', async () => {
    const { deps, calls, writtenXmls } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // /Create
        { stdout: '', stderr: '', code: 0 }, // /Run
      ],
      workDir,
      false,
    );
    const mgr = createSchtasksManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });

    expect(result.status).toBe('installed');
    expect(result.taskName).toBe(KIMI_SERVER_TASK_NAME);
    expect(writtenXmls.length).toBe(1);
    expect(writtenXmls[0]).toContain(`<Description>Kimi Code local server`);
    expect(writtenXmls[0]).not.toContain('--host');
    expect(writtenXmls[0]).toContain('--port 58627');

    expect(calls.length).toBe(2);
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      '/Create',
      '/TN',
      KIMI_SERVER_TASK_NAME,
      '/XML',
    ]);
    expect(calls[1]?.args).toEqual(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
  });

  it('refuses to overwrite without --force', async () => {
    const { deps, calls } = makeDeps([], workDir, true);
    const mgr = createSchtasksManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });
    expect(result.status).toBe('already-installed');
    expect(calls.length).toBe(0);
  });

  it('adds /F when force=true and task exists', async () => {
    const { deps, calls } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // /Create /F
        { stdout: '', stderr: '', code: 0 }, // /Run
      ],
      workDir,
      true,
    );
    const mgr = createSchtasksManager(deps);
    const result = await mgr.install({ host: '0.0.0.0', port: 9999, logLevel: 'debug', force: true });
    expect(result.status).toBe('replaced');
    expect(calls[0]?.args).toContain('/F');
  });

  it('returns "replaced but /Run failed" when activation fails', async () => {
    const { deps } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // /Create
        { stdout: '', stderr: 'task scheduler unavailable', code: 1 }, // /Run
      ],
      workDir,
      false,
    );
    const mgr = createSchtasksManager(deps);
    const result = await mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' });
    expect(result.status).toBe('installed');
    expect(result.message).toMatch(/\/Run failed/);
  });
});

describe('schtasks manager — lifecycle', () => {
  it('start delegates to /Run', async () => {
    const { deps, calls } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir, true);
    const mgr = createSchtasksManager(deps);
    const result = await mgr.start();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
  });

  it('start refuses when not installed', async () => {
    const { deps, calls } = makeDeps([], workDir, false);
    const mgr = createSchtasksManager(deps);
    const result = await mgr.start();
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('stop delegates to /End', async () => {
    const { deps, calls } = makeDeps([{ stdout: '', stderr: '', code: 0 }], workDir, true);
    const mgr = createSchtasksManager(deps);
    const result = await mgr.stop();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
  });

  it('restart fires /End then /Run', async () => {
    const { deps, calls } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 },
        { stdout: '', stderr: '', code: 0 },
      ],
      workDir,
      true,
    );
    const mgr = createSchtasksManager(deps);
    const result = await mgr.restart();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
    expect(calls[1]?.args).toEqual(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
  });

  it('uninstall calls /End + /Delete and clears plan', async () => {
    const { deps, calls } = makeDeps(
      [
        { stdout: '', stderr: '', code: 0 }, // /End (best-effort)
        { stdout: '', stderr: '', code: 0 }, // /Delete /F
      ],
      workDir,
      true,
    );
    writeInstallPlan({
      host: '127.0.0.1',
      port: 58627,
      logLevel: 'info',
      program: 'C:\\kimi.exe',
      programArguments: ['C:\\kimi.exe', 'server', 'run'],
      logPath: 'C:\\tmp\\x',
      installedAt: '2026-06-11T00:00:00.000Z',
    });
    expect(readInstallPlan()).toBeDefined();

    const mgr = createSchtasksManager(deps);
    const result = await mgr.uninstall();
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
    expect(calls[1]?.args).toEqual(['/Delete', '/TN', KIMI_SERVER_TASK_NAME, '/F']);
    expect(readInstallPlan()).toBeUndefined();
  });
});

describe('schtasks manager — status', () => {
  it('reports installed=false when no task exists', async () => {
    const { deps } = makeDeps([], workDir, false);
    const mgr = createSchtasksManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.platform).toBe('win32');
    expect(status.taskName).toBe(KIMI_SERVER_TASK_NAME);
  });

  it('reports running=true when /Query returns Status=Running', async () => {
    const csv = [
      '"HostName","TaskName","Status","Last Result"',
      '"WORKSTATION","\\KimiServer","Running","0"',
    ].join('\r\n');
    const { deps } = makeDeps([{ stdout: csv, stderr: '', code: 0 }], workDir, true);
    writeInstallPlan({
      host: '127.0.0.1',
      port: 58627,
      logLevel: 'info',
      program: 'C:\\kimi.exe',
      programArguments: [],
      logPath: 'C:\\tmp\\x',
      installedAt: '2026-06-11T00:00:00.000Z',
    });

    const mgr = createSchtasksManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.host).toBe('127.0.0.1');
    expect(status.port).toBe(58627);
  });

  it('reports installed=true, running=false when /Query fails', async () => {
    const { deps } = makeDeps(
      [{ stdout: '', stderr: 'ACCESS DENIED', code: 1 }],
      workDir,
      true,
    );
    const mgr = createSchtasksManager(deps);
    const status = await mgr.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.notes?.[0]).toMatch(/schtasks \/Query failed/);
  });
});
