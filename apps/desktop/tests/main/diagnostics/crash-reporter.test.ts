import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  version: '1.2.0',
  isPackaged: true,
  setPath: vi.fn(),
  start: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.version,
    get isPackaged() {
      return mocks.isPackaged;
    },
    setPath: mocks.setPath,
  },
  crashReporter: { start: mocks.start },
}));
vi.mock('../../../src/main/diagnostics/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/diagnostics/log')>()),
  log: { info: mocks.info, warn: mocks.warn, error: vi.fn() },
}));

import { startCrashReporter } from '../../../src/main/diagnostics/crash-reporter';
import { diagnosticRoots } from '../../../src/main/diagnostics/log';

function crashDumpsRoot(): string {
  return join(process.env['KIMI_CODE_HOME']!, 'logs', 'desktop-crashes');
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.version = '1.2.0';
  mocks.isPackaged = true;
  vi.stubEnv('KIMI_CODE_HOME', await mkdtemp(join(tmpdir(), 'kimi-crash-home-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('startCrashReporter', () => {
  it('keeps minidumps local under the logs folder, per release channel', async () => {
    mocks.version = '1.3.0-canary.20261029';
    startCrashReporter();
    const dir = join(crashDumpsRoot(), 'canary');
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(mocks.setPath).toHaveBeenCalledWith('crashDumps', dir);
    expect(mocks.start).toHaveBeenCalledWith({ uploadToServer: false, globalExtra: { channel: 'canary' } });
    expect(mocks.setPath.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
  });

  it('keeps the folder it started in among the diagnostic roots after KIMI_CODE_HOME moves', async () => {
    const startupLogs = join(process.env['KIMI_CODE_HOME']!, 'logs');
    startCrashReporter();
    const movedHome = await mkdtemp(join(tmpdir(), 'kimi-crash-moved-'));
    vi.stubEnv('KIMI_CODE_HOME', movedHome);
    expect(diagnosticRoots()).toEqual(expect.arrayContaining([join(movedHome, 'logs'), startupLogs]));
    expect(diagnosticRoots()[0]).toBe(join(movedHome, 'logs'));
  });

  it('files development builds under their own channel', () => {
    mocks.isPackaged = false;
    startCrashReporter();
    expect(mocks.setPath).toHaveBeenCalledWith('crashDumps', join(crashDumpsRoot(), 'dev'));
  });

  it('logs and carries on when the reporter cannot start', () => {
    mocks.start.mockImplementationOnce(() => {
      throw new Error('crashpad handler missing');
    });
    expect(() => startCrashReporter()).not.toThrow();
    expect(mocks.warn).toHaveBeenCalledWith('[crash] reporter unavailable: crashpad handler missing');
  });
});
