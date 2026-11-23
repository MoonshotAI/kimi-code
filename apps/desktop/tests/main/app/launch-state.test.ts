import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  version: '1.3.0',
  appListeners: new Map<string, () => void>(),
  processListeners: new Map<string, () => void>(),
  track: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.version,
    isPackaged: true,
    on: (event: string, listener: () => void) => mocks.appListeners.set(event, listener),
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.track, trySendDesktopEvent: vi.fn() }));

import type { LaunchRecord } from '../../../src/main/app/launch-state';

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    launchId: 'previous01',
    pid: 99_999_999,
    version: '1.2.0',
    startedAt: 1_000,
    updatedAt: 61_000,
    stage: 'boot-sessions',
    cleanExit: false,
    rendererGone: false,
    mainException: true,
    ...overrides,
  };
}

let home = '';

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.version = '1.3.0';
  mocks.appListeners.clear();
  mocks.processListeners.clear();
  home = await mkdtemp(join(tmpdir(), 'kimi-launch-home-'));
  vi.stubEnv('KIMI_CODE_HOME', home);
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    mocks.processListeners.set(event, listener);
    return process;
  }) as unknown as typeof process.on);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('evaluatePreviousLaunch', () => {
  it('reports a launch that never reached a clean exit', async () => {
    const { evaluatePreviousLaunch } = await import('../../../src/main/app/launch-state');
    expect(evaluatePreviousLaunch(record(), '1.3.0', () => false)).toEqual({
      last_stage: 'boot-sessions',
      uptime_ms: 60_000,
      version_changed: true,
      renderer_gone: false,
      main_exception: true,
      previous_launch_id: 'previous01',
    });
  });

  it('stays quiet for clean exits, missing records and processes that are still running', async () => {
    const { evaluatePreviousLaunch } = await import('../../../src/main/app/launch-state');
    expect(evaluatePreviousLaunch(record({ cleanExit: true }), '1.3.0', () => false)).toBeNull();
    expect(evaluatePreviousLaunch(null, '1.3.0', () => false)).toBeNull();
    expect(evaluatePreviousLaunch(record(), '1.3.0', () => true)).toBeNull();
  });

  it('rejects malformed records', async () => {
    const { asLaunchRecord } = await import('../../../src/main/app/launch-state');
    expect(asLaunchRecord(record())).toEqual(record());
    expect(asLaunchRecord({ ...record(), cleanExit: 'no' })).toBeNull();
    expect(asLaunchRecord({ ...record(), pid: Number.NaN })).toBeNull();
    expect(asLaunchRecord('nope')).toBeNull();
  });
});

describe('startLaunchTracking', () => {
  async function statePath(): Promise<string> {
    return join(home, 'logs', 'desktop-launch-stable.json');
  }

  async function readState(): Promise<LaunchRecord> {
    return JSON.parse(await readFile(await statePath(), 'utf-8')) as LaunchRecord;
  }

  it('reports the abnormal previous launch, then records this one stage by stage until a clean quit', async () => {
    await mkdir(join(home, 'logs'), { recursive: true });
    await writeFile(await statePath(), JSON.stringify(record()));
    const { startLaunchTracking, markRendererGone } = await import('../../../src/main/app/launch-state');
    const { logStartup, launchId } = await import('../../../src/main/diagnostics/log');

    startLaunchTracking(() => false);

    expect(mocks.track).toHaveBeenCalledWith('previous_launch_abnormal', expect.objectContaining({
      last_stage: 'boot-sessions',
      previous_launch_id: 'previous01',
      version_changed: true,
    }));
    expect(await readState()).toMatchObject({ launchId: launchId(), pid: process.pid, version: '1.3.0', stage: 'launched', cleanExit: false });

    logStartup('ui-mounted');
    expect((await readState()).stage).toBe('ui-mounted');
    mocks.processListeners.get('unhandledRejection')?.();
    markRendererGone();
    expect(await readState()).toMatchObject({ mainException: true, rendererGone: true });

    mocks.appListeners.get('will-quit')?.();
    expect(await readState()).toMatchObject({ stage: 'quit', cleanExit: true });
    logStartup('ui-ready');
    expect((await readState()).stage).toBe('quit');
  });

  it('keeps the quitting stage once the quit is committed so a kill during shutdown stays recognizable', async () => {
    const { startLaunchTracking, markQuitStarted } = await import('../../../src/main/app/launch-state');
    const { logStartup } = await import('../../../src/main/diagnostics/log');

    startLaunchTracking(() => false);
    logStartup('server-ready');
    markQuitStarted();
    logStartup('ui-ready');
    expect(await readState()).toMatchObject({ stage: 'quitting', cleanExit: false });

    mocks.appListeners.get('will-quit')?.();
    expect(await readState()).toMatchObject({ stage: 'quit', cleanExit: true });
  });

  it('refreshes the record every five minutes so an abnormal end reports a realistic uptime', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const { startLaunchTracking } = await import('../../../src/main/app/launch-state');
      startLaunchTracking(() => false);
      vi.advanceTimersByTime(5 * 60_000);
      expect((await readState()).updatedAt).toBe(1_000_000 + 5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report anything after a clean previous exit and only starts once', async () => {
    await mkdir(join(home, 'logs'), { recursive: true });
    await writeFile(await statePath(), JSON.stringify(record({ cleanExit: true })));
    const { startLaunchTracking } = await import('../../../src/main/app/launch-state');
    startLaunchTracking(() => false);
    startLaunchTracking(() => false);
    expect(mocks.track).not.toHaveBeenCalled();
    expect(mocks.appListeners.has('will-quit')).toBe(true);
  });
});
